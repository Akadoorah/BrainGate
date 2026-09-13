import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { BrainGateInvariantError } from "./errors.js";
import { assertRegisteredProject, parseProjectConfig, type ProjectConfig, type ProjectId, type RegisteredProject } from "./project-registry.js";
import { canonicalDirectory } from "./workspace.js";
import { findManifest } from "./manifest-path.js";

/**
 * Which workspace BrainGate is attached to, and whether it is the one it would execute against.
 *
 * Two defects meet here, and the model has to answer both.
 *
 * The first: a project's identity was a *slug* — a directory name, resolving to
 * `<home>/projects/<slug>` — and nothing compared it with the directory the operator had launched
 * from. Two clones of one repository could both carry `project_id: flutter-migration`, write to the
 * same ledger, and be one project. In real dogfood the operator launched from a clone in `Downloads`
 * and found BrainGate reasoning about a clone on `Lexar`.
 *
 * The second, and the reason this module no longer speaks of checkouts: identity was also made to be
 * `git rev-parse --show-toplevel`. That is not what a native CLI runs in. An operator who launches
 * inside `repo/flutter_migration` wants Claude Code's `cwd` to be `repo/flutter_migration`, and Git
 * had silently widened it to `repo`. Git is a capability a workspace may have; it is not how a
 * workspace is identified.
 *
 * So identity is the selected directory, canonicalized, and nothing else:
 *
 * - **Project identity** is the operator's name for the work. It owns durable memory and preferences.
 * - **Workspace identity** is a canonical absolute path. Two directories are two workspaces even when
 *   they share a basename, a git remote, a repository and a project id, because they hold different
 *   files and a worker that edits one has not touched the other.
 *
 * The manifest records which workspace the project is bound to, and this module enforces that
 * binding: the execution path must be the workspace the operator selected.
 */

/**
 * The local directory the operator is working in, and what is known about it.
 *
 * `path` is the selected workspace itself — the directory they launched from, canonicalized — and it
 * is the identity. `gitRoot` is metadata that may or may not exist: a workspace inside a repository
 * has one, a workspace that is not a repository does not, and neither fact changes which directory
 * the native CLIs will run in.
 */
export interface Checkout {
  /** The selected directory, canonicalized. The workspace identity and the execution boundary. */
  readonly root: string;
  /** The repository this directory sits in, when Git is present. Evidence, never identity. */
  readonly gitRoot: string | null;
  /** The manifest that named it, or `null` for a workspace that has never been registered. */
  readonly manifestPath: string | null;
}

/**
 * The repository a directory sits in, when it sits in one.
 *
 * Metadata. It decides nothing: not whether a workspace exists, not whether one may be registered,
 * and not where a native CLI runs. It is recorded because branch, HEAD and dirty state are useful
 * evidence, and because the strict snapshot and worktree policies need to know whether there is a
 * repository to work with.
 *
 * `git rev-parse --show-toplevel` rather than a walk for a `.git` directory, so worktrees, submodules
 * and a `.git` *file* all resolve the way git resolves them.
 *
 * `null` when the directory is not inside a repository, which is an ordinary workspace.
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

/** The workspace the operator is in, and whether it has ever been registered. */
export function identifyCheckout(cwd: string, manifest = ".brain/project.json"): Checkout {
  // The workspace is where the operator is. Canonicalized, so a symlinked path and its target are
  // one workspace rather than two; not replaced by anything Git says, because the directory they
  // chose is the one a native CLI should run in.
  const root = canonicalDirectory(cwd) ?? resolve(cwd);
  // A manifest is looked for from here, upward, so a session started in a subdirectory still finds
  // the one `init` wrote. What it names is then checked against the workspace — which is the check
  // that did not exist.
  const manifestPath = findManifest(cwd, manifest);
  const found = existsSync(manifestPath) ? manifestPath : null;
  return Object.freeze({ root, gitRoot: checkoutRootOf(cwd), manifestPath: found });
}

export type AttachRefusal =
  | "different-workspace"
  | "registered-workspace-missing"
  | "registered-path-not-a-directory";

export type Attachment =
  | {
    readonly kind: "attached";
    readonly project: RegisteredProject;
    readonly checkout: Checkout;
    readonly registeredRoot: string;
  }
  | {
    /**
     * The operator named a manifest that belongs somewhere else, and is not standing in it.
     *
     * This is `braingate status --project /elsewhere/.brain/project.json` from a home directory:
     * naming a project explicitly to read what it recorded is a legitimate thing to do, and it is
     * not an attachment. Nothing may execute against `checkout.root` — the workspace is the one the
     * registration names — and every execution path keeps its own guard for exactly that reason.
     */
    readonly kind: "inspecting";
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
 * Whether BrainGate may execute against this workspace, and why not when it may not.
 *
 * The invariant, in one sentence: **the execution path is the workspace the operator selected.**
 * Everything downstream — the provider's cwd, snapshots, worktrees, fingerprints, task evidence,
 * native session binding — follows from the handle this returns, so this is the one place the
 * question is asked.
 *
 * A disagreement is refused in every direction. Not continued against the registered workspace,
 * which would run somewhere the operator is not looking. Not silently rebound to the current one,
 * which would move a project's memory and history onto different work. Not resolved by basename,
 * remote URL or repository, because those say two directories are *related* and nothing about
 * whether they hold the same files.
 */
export function resolveAttachment(input: {
  readonly cwd: string;
  readonly registry: { readonly loadFile: (path: string) => RegisteredProject };
  readonly manifest?: string;
  /**
   * Whether the operator named this manifest themselves, as `--project <path>` does.
   *
   * The manifest is normally found by walking up from where they are, so the only way the two can
   * disagree is a directory that carries someone else's registration — a clone copied to a second
   * volume — and that is refused. An explicitly named manifest is a different act: it says "this
   * project", from wherever the operator happens to be, and reading what it recorded is what they
   * asked for. Nothing executes against the current directory in that case either; the workspace
   * stays the one the registration names, and the execution paths guard the question themselves.
   */
  readonly namedByOperator?: boolean;
}): Attachment {
  const checkout = identifyCheckout(input.cwd, input.manifest ?? ".brain/project.json");

  if (checkout.manifestPath === null) {
    return Object.freeze({ kind: "unregistered" as const, checkout });
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
      reason: "registered-workspace-missing" as const,
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
        "  `braingate init --project-id <new-id>`  register this directory as its own project",
      ].join("\n"),
    });
  }

  const registeredRoot = project.repositories[0] ?? null;
  if (registeredRoot === null) {
    return Object.freeze({
      kind: "refused" as const,
      reason: "registered-workspace-missing" as const,
      checkout,
      registeredRoot: null,
      projectId: project.projectId,
      message: `Project ${project.projectId} names no repository, so there is nothing to execute against.`,
    });
  }

  if (registeredRoot === checkout.root) {
    return Object.freeze({ kind: "attached" as const, project, checkout, registeredRoot });
  }

  // A registration that names a *parent* of this directory is the shape a workspace-in-a-repository
  // has under the old model, and it is still a legitimate selection: an operator who registered the
  // repository may work in one of its subdirectories. It is accepted only when the directory is
  // inside it, and the workspace is still the directory they are in — the provider's cwd is where
  // they launched, never the parent they happened to register.
  if (checkout.root.startsWith(`${registeredRoot}/`) && canonicalDirectory(registeredRoot) !== null) {
    return Object.freeze({ kind: "attached" as const, project, checkout, registeredRoot });
  }

  // The one case this whole module exists for. The registered path is canonicalized (the registry
  // does that when it loads), and so is the workspace, so this comparison is between two real
  // locations rather than two spellings of one.
  // A directory that is gone and a directory that is not a directory are different facts: the first
  // is an unmounted volume or a move, the second is a path that no longer means a workspace.
  const registeredExists = existsSync(registeredRoot);
  const registeredIsDirectory = registeredExists && statSync(registeredRoot).isDirectory();
  const reason: AttachRefusal = !registeredExists
    ? "registered-workspace-missing"
    : !registeredIsDirectory
      ? "registered-path-not-a-directory"
      : "different-workspace";

  if (reason === "different-workspace" && input.namedByOperator === true) {
    return Object.freeze({ kind: "inspecting" as const, project, checkout, registeredRoot });
  }

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
  const head = `Project \`${input.projectId}\` is registered to a different workspace.`;
  const body = [
    `  registered:  ${input.registeredRoot}`,
    `  you are in:  ${input.current}`,
  ].join("\n");
  switch (input.reason) {
    case "different-workspace":
      return [
        head,
        body,
        "",
        "These are two local directories, and BrainGate will not choose between them: they can hold",
        "different files and different uncommitted state, and a worker that edits one has not",
        "",
        "  `braingate init --project-id <new-id>`  register this directory as its own project",
        "  `braingate init --rebind`               move this project's registration here instead",
      ].join("\n");
    case "registered-workspace-missing":
      return [
        `Project \`${input.projectId}\` is registered to a checkout that is not there:`,
        `  registered:  ${input.registeredRoot}`,
        `  you are in:  ${input.current}`,
        "",
        "An unmounted drive and a moved directory look the same from here, so BrainGate will not",
        "guess which happened.",
        "",
        "  `braingate init --rebind`               point this project at this checkout",
        "  `braingate init --project-id <new-id>`  register this directory as its own project",
      ].join("\n");
    case "registered-path-not-a-directory":
      return [
        `Project \`${input.projectId}\` is registered to a directory that is no longer usable:`,
        `  registered:  ${input.registeredRoot}`,
        `  you are in:  ${input.current}`,
        "",
        "Nothing was executed against it.",
        "",
        "  `braingate init --rebind`               point this project at this checkout",
      ].join("\n");
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
  if (attachment.kind !== "attached" && attachment.kind !== "inspecting") {
    throw new BrainGateInvariantError("PROJECT_CHECKOUT_MISMATCH", attachment.kind === "refused" ? attachment.message : "No BrainGate project is registered for this workspace.");
  }
  assertRegisteredProject(attachment.project);
  return attachment.project;
}
