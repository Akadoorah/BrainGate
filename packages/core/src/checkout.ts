import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError } from "./errors.js";
import { assertRegisteredProject, parseProjectConfig, type ProjectConfig, type ProjectId, type RegisteredProject } from "./project-registry.js";
import { findManifest } from "./manifest-path.js";

/**
 * Which local checkout BrainGate is attached to, and whether it is the one it would execute against.
 *
 * The defect this exists to remove: a project's identity was a *slug* — a directory name, written
 * into a manifest, resolving to `<home>/projects/<slug>` — and nothing ever compared that with the
 * repository the operator had actually launched from. Two clones of one repository, on two volumes,
 * could both carry `project_id: flutter-migration`, write to the same ledger, and be one project as
 * far as BrainGate was concerned. In real dogfood the operator launched from a clone in `Downloads`
 * and found BrainGate reasoning about a different clone on `Lexar`, which is the failure this makes
 * unrepresentable.
 *
 * The distinction the model needs is narrow and worth stating exactly, because over-modelling it is
 * as wrong as not modelling it:
 *
 * - **Project identity** is the operator's name for the work — `flutter-migration`. It owns memory,
 *   goals, the ledger, quota history and the audit trail.
 * - **Checkout identity** is the local directory the work happens in. It is a canonical absolute path
 *   and nothing else. Two clones of one repository are two checkouts even when they share a basename,
 *   a remote URL and a project id, because they hold different uncommitted state and a provider that
 *   edits one has not touched the other.
 *
 * What binds them is a decision the operator made, recorded in the manifest beside the checkout.
 * BrainGate's job is to enforce it, and to refuse instead of guessing when the two disagree.
 */

/** A local checkout, identified by its canonical path and nothing else. */
export interface Checkout {
  /** `git rev-parse --show-toplevel`, canonicalized. The identity of the checkout. */
  readonly root: string;
  /** The manifest that named it, or `null` for a checkout that has never been registered. */
  readonly manifestPath: string | null;
}

/**
 * The repository root of the directory the operator is working in.
 *
 * `git rev-parse --show-toplevel` rather than a walk for a `.git` directory: worktrees, submodules
 * and a `.git` *file* all resolve correctly through git and not through a directory name, and the
 * question being asked is git's to answer.
 *
 * `null` when the directory is not inside a repository, which is the ordinary "you are somewhere
 * else" case rather than an error.
 */
export function checkoutRootOf(directory: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, encoding: "utf8", shell: false });
  if (result.status !== 0) return null;
  const top = String(result.stdout ?? "").trim();
  if (top.length === 0) return null;
  try {
    // Canonical, so a symlinked path and its target are one checkout rather than two. The whole
    // comparison below is a string equality, and an unresolved symlink is how that equality lies.
    return realpathSync.native(top);
  } catch {
    return null;
  }
}

/** The checkout the operator is in, and whether it has ever been registered. */
export function identifyCheckout(cwd: string, manifest = ".brain/project.json"): Checkout {
  const root = checkoutRootOf(cwd);
  // A manifest is looked for from where the operator is, upward, so a session started in a
  // subdirectory still finds the one `init` wrote at the top. What it names is then checked against
  // the repository the operator is actually in — which is the check that did not exist.
  const manifestPath = findManifest(cwd, manifest);
  const found = existsSync(manifestPath) ? manifestPath : null;
  if (root === null) {
    // Not in a repository: a manifest above this directory could still name one, and that is a
    // mismatch rather than a checkout. Reported as the manifest's own directory so the comparison
    // below can say so rather than crashing on a missing root.
    return Object.freeze({ root: found === null ? resolve(cwd) : dirname(dirname(found)), manifestPath: found });
  }
  return Object.freeze({ root, manifestPath: found });
}

export type AttachRefusal =
  | "different-checkout"
  | "registered-checkout-missing"
  | "registered-path-not-a-repository"
  | "not-a-repository";

export type Attachment =
  | {
    readonly kind: "attached";
    readonly project: RegisteredProject;
    readonly checkout: Checkout;
    readonly registeredRoot: string;
  }
  | {
    readonly kind: "refused";
    readonly reason: AttachRefusal;
    /** The checkout the operator is in. May be a directory that is not a repository. */
    readonly checkout: Checkout;
    /** What the registration names, when there is a registration to name anything. */
    readonly registeredRoot: string | null;
    readonly projectId: ProjectId | null;
    readonly message: string;
  }
  | {
    /** No manifest anywhere above the operator. The ordinary first run, not a refusal. */
    readonly kind: "unregistered";
    readonly checkout: Checkout;
  };

function canonical(path: string): string | null {
  try { return realpathSync.native(resolve(path)); }
  catch { return null; }
}

/**
 * Whether BrainGate may execute against this checkout, and why not when it may not.
 *
 * The invariant, in one sentence: **the repository used for execution is the repository the operator
 * attached from.** Everything downstream — snapshots, worktrees, fingerprints, the provider's cwd,
 * task evidence, memory scope — follows from the project handle this returns, so this is the one
 * place the question is asked.
 *
 * A disagreement is refused in every direction. Not continued against the registered checkout, which
 * would be executing somewhere the operator is not looking. Not silently rebound to the current one,
 * which would move a project's memory and history onto a different body of work. Not resolved by
 * basename, remote URL or slug, because those say the two clones are *related* and nothing about
 * whether they hold the same uncommitted state.
 */
export function resolveAttachment(input: {
  readonly cwd: string;
  readonly registry: { readonly loadFile: (path: string) => RegisteredProject };
  readonly manifest?: string;
}): Attachment {
  const checkout = identifyCheckout(input.cwd, input.manifest ?? ".brain/project.json");

  if (checkout.manifestPath === null) {
    return Object.freeze({ kind: "unregistered" as const, checkout });
  }
  if (checkout.root === null || checkout.root === resolve(input.cwd)) {
    // Either the directory is not in a repository at all, or the manifest is not inside one. There
    // is no canonical root to compare, and a registration cannot be honoured without one.
    return Object.freeze({
      kind: "refused" as const,
      reason: "not-a-repository" as const,
      checkout,
      registeredRoot: null,
      projectId: null,
      message: `${input.cwd} is not inside a git repository, so there is no checkout to attach. Run BrainGate from inside the repository it should work on.`,
    });
  }

  let project: RegisteredProject;
  try {
    project = input.registry.loadFile(checkout.manifestPath);
  } catch (error) {
    // The manifest exists and names a repository that cannot be resolved — an external drive that is
    // not mounted, a directory that was moved or deleted. Refused with that as the reason, rather
    // than treated as a first run: the registration is real, it just cannot be honoured here.
    const registered = registeredRootFrom(checkout.manifestPath);
    return Object.freeze({
      kind: "refused" as const,
      reason: "registered-checkout-missing" as const,
      checkout,
      registeredRoot: registered.root,
      projectId: registered.projectId,
      message: [
        registered.projectId === null
          ? "This project is registered to a checkout that is not usable right now."
          : `Project \`${registered.projectId}\` is registered to a checkout that is not usable right now.`,
        ...(registered.root === null ? [] : ["", `  registered:  ${registered.root}`]),
        `  you are in:  ${checkout.root}`,
        "",
        "An unmounted drive and a moved directory look the same from here, so BrainGate will not",
        "guess which happened.",
        "",
        "  `braingate init --rebind`               point this project at this checkout",
        "  `braingate init --project-id <new-id>`  register this checkout as its own project",
      ].join("\n"),
    });
  }

  const registeredRoot = project.repositories[0] ?? null;
  if (registeredRoot === null) {
    return Object.freeze({
      kind: "refused" as const,
      reason: "registered-checkout-missing" as const,
      checkout,
      registeredRoot: null,
      projectId: project.projectId,
      message: `Project ${project.projectId} names no repository, so there is nothing to execute against.`,
    });
  }

  if (registeredRoot === checkout.root) {
    return Object.freeze({ kind: "attached" as const, project, checkout, registeredRoot });
  }

  // The one case this whole module exists for. The registered path is canonicalized (the registry
  // does that when it loads), and so is the git root, so this comparison is between two real
  // locations rather than two spellings of one.
  const registeredExists = existsSync(registeredRoot) && statSync(registeredRoot).isDirectory();
  const registeredIsRepository = registeredExists && checkoutRootOf(registeredRoot) !== null;
  const reason: AttachRefusal = !registeredExists
    ? "registered-checkout-missing"
    : !registeredIsRepository
      ? "registered-path-not-a-repository"
      : "different-checkout";

  return Object.freeze({
    kind: "refused" as const,
    reason,
    checkout,
    registeredRoot,
    projectId: project.projectId,
    message: refusalMessage({ reason, projectId: project.projectId, registeredRoot, current: checkout.root }),
  });
}

function refusalMessage(input: {
  readonly reason: AttachRefusal;
  readonly projectId: ProjectId;
  readonly registeredRoot: string;
  readonly current: string;
}): string {
  const head = `Project \`${input.projectId}\` is registered to a different checkout.`;
  const body = [
    `  registered:  ${input.registeredRoot}`,
    `  you are in:  ${input.current}`,
  ].join("\n");
  switch (input.reason) {
    case "different-checkout":
      return [
        head,
        body,
        "",
        "These are two local checkouts, and BrainGate will not choose between them: they can hold",
        "different uncommitted state, and a provider that edits one has not touched the other.",
        "",
        "  `braingate init --project-id <new-id>`  register this checkout as its own project",
        "  `braingate init --rebind`               move this project's registration here instead",
      ].join("\n");
    case "registered-checkout-missing":
      return [
        `Project \`${input.projectId}\` is registered to a checkout that is not there:`,
        `  registered:  ${input.registeredRoot}`,
        `  you are in:  ${input.current}`,
        "",
        "An unmounted drive and a moved directory look the same from here, so BrainGate will not",
        "guess which happened.",
        "",
        "  `braingate init --rebind`               point this project at this checkout",
        "  `braingate init --project-id <new-id>`  register this checkout as its own project",
      ].join("\n");
    case "registered-path-not-a-repository":
      return [
        `Project \`${input.projectId}\` is registered to a directory that is no longer a git checkout:`,
        `  registered:  ${input.registeredRoot}`,
        `  you are in:  ${input.current}`,
        "",
        "Nothing was executed against it.",
        "",
        "  `braingate init --rebind`               point this project at this checkout",
      ].join("\n");
    case "not-a-repository":
      return head;
  }
}

/**
 * The project id to suggest for a checkout that needs its own registration.
 *
 * A slug is a name, not an identity, so a slug that is taken is a reason to suggest a different name
 * rather than to share a registration. `taken` is asked about each candidate in turn.
 */
export function suggestProjectIdFor(checkoutRoot: string, taken: (candidate: string) => boolean): string | null {
  const slug = (value: string): string => value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  const base = slug(basename(checkoutRoot));
  if (base.length === 0) return null;
  if (!taken(base)) return base;
  // A parent's name disambiguates two clones of one repository far better than a number does, and
  // still falls back to one when even that collides.
  const parent = slug(basename(dirname(checkoutRoot)));
  const qualified = parent.length === 0 ? base : slug(`${base}-${parent}`);
  if (qualified.length > 0 && !taken(qualified)) return qualified;
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = slug(`${base}-${String(suffix)}`);
    if (candidate.length > 0 && !taken(candidate)) return candidate;
  }
  return null;
}

/**
 * What a manifest says, when it can be read at all.
 *
 * Used on the failure path: a manifest naming a repository that no longer exists cannot go through
 * the registry — that is the failure — but the operator still needs to see which project and which
 * path are in question, because those are what the remedy acts on.
 */
function registeredRootFrom(manifestPath: string): { readonly projectId: ProjectId | null; readonly root: string | null } {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly project_id?: unknown; readonly repositories?: unknown };
    const projectId = typeof raw.project_id === "string" ? raw.project_id as ProjectId : null;
    const first = Array.isArray(raw.repositories) ? raw.repositories[0] : undefined;
    // Not canonicalized through the registry: the point of this path is that the registry refused it.
    const root = typeof first === "string" ? resolve(dirname(dirname(resolve(manifestPath))), first) : null;
    return Object.freeze({ projectId, root });
  } catch {
    return Object.freeze({ projectId: null, root: null });
  }
}

/**
 * Whether a registration's repository is still the checkout the manifest sits in.
 *
 * Used by `--rebind` to say what it is moving away from, and by `/project` to report the binding
 * without resolving a project handle.
 */
export function manifestBinding(manifestPath: string): { readonly projectId: ProjectId; readonly registeredRoot: string | null; readonly manifestRoot: string | null } {
  const config: ProjectConfig = parseProjectConfig(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown, dirname(resolve(manifestPath)));
  return Object.freeze({
    projectId: config.projectId,
    registeredRoot: config.repositories[0] ?? null,
    manifestRoot: dirname(dirname(resolve(manifestPath))),
  });
}

/** Where a checkout's manifest belongs: at its root, in `.brain`, as `init` writes it. */
export function manifestPathFor(checkoutRoot: string, manifest = ".brain/project.json"): string {
  return join(checkoutRoot, manifest);
}

/** Asserts an attachment is usable, for a caller that has already decided how to report a refusal. */
export function requireAttached(attachment: Attachment): RegisteredProject {
  if (attachment.kind !== "attached") {
    throw new BrainGateInvariantError("PROJECT_CHECKOUT_MISMATCH", attachment.kind === "refused" ? attachment.message : "No BrainGate project is registered for this checkout.");
  }
  assertRegisteredProject(attachment.project);
  return attachment.project;
}
