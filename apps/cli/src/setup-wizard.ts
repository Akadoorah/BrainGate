import { basename, resolve } from "node:path";
import { ProjectRegistry, executionScopeFor, resolveAttachment, type ExecutionScope } from "@braingate/core";
import {
  ModelCatalog,
  ProviderAcceptanceStore,
  UNSCOPED_PROVIDER_RISK,
  adoptDiscoveredModels,
  analyzeModelCoverage,
  planModelAdoption,
  resolveOperatorState,
  type AdoptionRow,
} from "@braingate/operator";
import {
  ANTIGRAVITY_READ_RULE,
  ANTIGRAVITY_SHELL_RULE,
  ModelListCache,
  NodeProbeRunner,
  ProviderDiscovery,
  readAntigravityHeadlessPermissions,
  type ProviderSnapshot,
} from "@braingate/providers";
import { runDogfoodCli, suggestedProjectId } from "./dogfood-cli.js";
import { acceptanceNeededFor } from "./provider-proof.js";
import { sessionPreferencesPath, updateSessionPreferences } from "./session-preferences.js";

/**
 * The first ten minutes.
 *
 * Everything this asks was already possible: `braingate init`, then a JSON definition per model
 * through `models add`, then `providers accept`, then reading three documents to find out which of
 * those were needed. That is a research task standing where a first run should be, and it is why
 * BrainGate had one operator. This is the same work, asked as four questions, with every answer
 * changeable afterwards by a slash command.
 *
 * What it deliberately does *not* do:
 *
 * - It writes no provider's settings. Antigravity's DIRECT rules live in the operator's own
 *   `settings.json` and BrainGate only ever reads them (ADR 0020); when they are missing the wizard
 *   prints the two rules and the path and says who has to add them.
 * - It records no quota state, and reads none. Quota comes from each CLI's own reporting (ADR 0012).
 * - It never overwrites a score the operator set. A rerun reports those as `kept`.
 * - It asks about the unscoped-provider risk only where an acceptance would actually grant
 *   something, through the same test `braingate providers accept` uses.
 *
 * The questions are at most four; everything else it decided is printed as `assumed`, because a
 * default nobody was told about is indistinguishable from a bug.
 */

export interface SetupWizardDependencies {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Absent means nobody is there to answer: every question falls back to its scripted answer. */
  readonly ask?: (question: string) => Promise<string | null>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly discoverAll?: () => Promise<readonly ProviderSnapshot[]>;
  /**
   * Answers decided in advance, for the non-interactive path.
   *
   * `braingate init --adopt-models --accept google` is the same wizard with three of its four
   * questions already answered, which is what keeps the scripted path and the interactive one from
   * becoming two implementations of one flow.
   */
  readonly answers?: {
    readonly register?: boolean;
    readonly adoptModels?: boolean;
    readonly accept?: readonly string[];
    readonly reviewAlways?: boolean;
  };
  /** The project identity, when the operator named it on the command line. */
  readonly identity?: { readonly projectId?: string; readonly name?: string };
}

export interface SetupWizardResult {
  readonly registered: boolean;
  readonly projectId: string | null;
  readonly adopted: readonly string[];
  readonly assumed: readonly string[];
  readonly kept: readonly string[];
  readonly unscored: readonly string[];
  readonly accepted: readonly string[];
  readonly reviewAlways: boolean;
  readonly exitCode: number;
}

/** `provider/model`, which is how every other surface names a worker. */
function ref(row: { readonly providerId: string; readonly modelId: string }): string {
  return `${row.providerId}/${row.modelId}`;
}

/** One adoption line: who it is, what it is for, how fast, and where the id came from. */
function adoptionLine(row: AdoptionRow): string {
  const roles = row.roles.length === 0 ? "no default role" : row.roles.join(", ");
  const speed = row.profile === null ? "unscored" : row.profile.speed;
  return `    ${ref(row).padEnd(38)} ${roles} · ${speed} · ${row.origin}`;
}

/** A yes/no question with a stated default, or that default when nobody is there to answer. */
async function confirm(
  deps: SetupWizardDependencies,
  question: string,
  fallback: boolean,
  scripted: boolean | undefined,
): Promise<boolean> {
  if (scripted !== undefined) return scripted;
  if (deps.ask === undefined) return fallback;
  const answer = await deps.ask(question);
  if (answer === null) return fallback;
  const text = answer.trim();
  if (text.length === 0) return fallback;
  return /^y(es)?$/i.test(text);
}

/** Discovery, through the caller's seam when it gave one — the same cache every other surface uses. */
async function discover(deps: SetupWizardDependencies, globalDir: string): Promise<readonly ProviderSnapshot[]> {
  if (deps.discoverAll !== undefined) return await deps.discoverAll();
  const modelCache = new ModelListCache({ path: resolve(globalDir, "model-lists.json") });
  return await new ProviderDiscovery(new NodeProbeRunner(), { modelCache, env: deps.env ?? process.env }).discoverAll();
}

/** The first line of a captured command's output, which is the line worth repeating. */
function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

/**
 * What a signed-out CLI says to do about it, from its own snapshot.
 *
 * Taken from the discovery warnings and the provider's own binary rather than from a table of
 * login commands here: a login command baked into BrainGate goes stale the same way a model id
 * does, and the snapshot already carries the evidence.
 */
function signInHint(snapshot: ProviderSnapshot): string {
  const binary = snapshot.binary;
  const how = binary === "claude" ? `${binary} /login`
    : binary === "codex" ? `${binary} login`
      : binary === "grok" ? `${binary} login`
        : `${binary}`;
  return `    ${snapshot.providerId} (${binary}) is installed and not signed in — run \`${how}\` in your shell, then /providers here.`;
}

export async function runSetupWizard(deps: SetupWizardDependencies): Promise<SetupWizardResult> {
  const env = deps.env ?? process.env;
  const state = resolveOperatorState(env);
  const registryOf = { loadFile: (manifestPath: string) => new ProjectRegistry(state.home).loadFile(manifestPath) };
  const scripted = deps.answers ?? {};
  const empty: SetupWizardResult = Object.freeze({
    registered: false, projectId: null,
    adopted: Object.freeze([]), assumed: Object.freeze([]), kept: Object.freeze([]), unscored: Object.freeze([]),
    accepted: Object.freeze([]), reviewAlways: false, exitCode: 1,
  });

  // 1. The project. Its id is the isolation boundary for memory, worktrees and telemetry, so it is
  //    registered explicitly — but the answer is one key, because the directory already names it.
  let attachment = resolveAttachment({ cwd: deps.cwd, registry: registryOf });
  if (attachment.kind === "refused") { deps.stderr(`\n${attachment.message}\n\n`); return empty; }
  if (attachment.kind === "unregistered") {
    deps.stdout([
      "",
      `  No BrainGate project in ${basename(deps.cwd)} yet.`,
      "  The project id is the isolation boundary for memory, worktrees and telemetry,",
      "  so it is registered explicitly rather than assumed.",
      "",
    ].join("\n"));
    const register = await confirm(deps, `  Register ${deps.cwd} as a BrainGate project? [Y/n] `, true, scripted.register);
    if (!register) {
      deps.stdout("\n  Nothing registered. Run `braingate init` here when you are ready.\n\n");
      return empty;
    }
    deps.stdout("\n");
    /**
     * The identity, without a question about it.
     *
     * The directory already names the project, and two prompts for a display name are exactly the
     * kind of ceremony this wizard exists to remove. It is printed rather than asked, and
     * `braingate init --project-id <id> --name <name>` is still the way to choose something else.
     * Where the directory name slugifies to nothing, `init` asks the way it always did.
     */
    const directory = basename(deps.cwd);
    const suggested = deps.identity?.projectId ?? suggestedProjectId(directory);
    const displayName = deps.identity?.name ?? directory;
    if (suggested !== null) deps.stdout(`  assumed: project id \`${suggested}\`, name \`${displayName}\` — from this directory.\n`);
    const identityArgs = suggested === null ? [] : ["--project-id", suggested, "--name", displayName];
    const init = await runDogfoodCli(["init", ...identityArgs], {
      cwd: deps.cwd,
      // Indented into the wizard's own column: `init`'s confirmation is a line in this flow now,
      // not the output of a command the operator ran.
      stdout: (text) => deps.stdout(text.replace(/^(?=.)/gm, "  ")),
      stderr: deps.stderr,
      ...(deps.ask === undefined ? {} : { ask: deps.ask }),
      ...(deps.env === undefined ? {} : { env: deps.env }),
      quiet: true,
    });
    if (init.exitCode !== 0) return Object.freeze({ ...empty, exitCode: init.exitCode });
    attachment = resolveAttachment({ cwd: deps.cwd, registry: registryOf });
    deps.stdout("\n");
  } else if (attachment.kind === "attached") {
    deps.stdout(`\n  Project ${attachment.project.projectId} is already registered here. Nothing about it is changed.\n\n`);
  }
  const scope: ExecutionScope | null = attachment.kind === "attached" || attachment.kind === "inspecting"
    ? executionScopeFor(attachment.project, attachment.kind === "inspecting" ? attachment.registeredRoot : attachment.checkout.root)
    : null;
  const projectId = attachment.kind === "attached" || attachment.kind === "inspecting" ? attachment.project.projectId : null;

  // 2. The catalogue. Nothing routes without one, and writing one by hand is the step that used to
  //    end most first runs.
  const snapshots = await discover(deps, state.globalDir);
  const installed = snapshots.filter((snapshot) => snapshot.available.value === true);
  const catalog = new ModelCatalog(state.modelCatalogPath);
  const preview = planModelAdoption(catalog.load(), snapshots);
  const offered = preview.filter((row) => row.disposition === "adopt" || row.disposition === "assume");
  const kept = preview.filter((row) => row.disposition === "keep");
  const unmatched = preview.filter((row) => row.disposition === "unscored");

  let adopted: readonly AdoptionRow[] = Object.freeze([]);
  let assumedRows: readonly AdoptionRow[] = Object.freeze([]);
  let importedUnscored: readonly AdoptionRow[] = Object.freeze([]);
  if (installed.length === 0) {
    deps.stdout("  No provider CLI is installed on this machine, so there is nothing to adopt yet.\n");
    deps.stdout("  Install one of claude, codex, agy or grok, sign in, and run /setup again.\n\n");
  } else if (offered.length === 0) {
    deps.stdout(kept.length === 0
      ? "  The installed CLIs list no model BrainGate has starting scores for.\n\n"
      : `  Your catalogue already scores ${String(kept.length)} of the installed models; nothing to adopt.\n\n`);
  } else {
    deps.stdout(`  Found ${String(offered.length)} model(s) on ${String(new Set(offered.map((row) => row.providerId)).size)} subscription(s):\n\n`);
    for (const row of offered) deps.stdout(`${adoptionLine(row)}\n`);
    if (kept.length > 0) {
      deps.stdout(`\n    already yours, kept (your scores): ${kept.map(ref).join(", ")}\n`);
    }
    deps.stdout("\n  These are BrainGate's starting scores, not measurements. They are labelled as such in\n  `models profile`, and anything you score yourself is never overwritten by them.\n\n");
    const adopt = await confirm(deps, `  Adopt these ${String(offered.length)} models with these starting scores? [Y/n] `, true, scripted.adoptModels);
    if (adopt) {
      const result = adoptDiscoveredModels(catalog, snapshots);
      adopted = result.adopted;
      assumedRows = result.assumed;
      importedUnscored = result.unscored;
      deps.stdout(`\n  Adopted ${String(adopted.length + assumedRows.length)} model(s)${assumedRows.length === 0 ? "" : ` (${String(assumedRows.length)} assumed)`}.\n`);
      if (importedUnscored.length > 0) {
        deps.stdout(`  Imported unscored, so they are visible but unrouted: ${importedUnscored.map(ref).join(", ")}.\n`);
      }
      deps.stdout("\n");
    } else {
      deps.stdout("\n  Nothing adopted. `braingate models add --definition <file>` is the explicit way.\n\n");
    }
  }
  // A CLI that is installed and signed out is the commonest reason a first run finds nothing: the
  // wizard names it and the command that fixes it, and spends nothing trying.
  const signedOut = installed.filter((snapshot) => snapshot.authState.value === "unauthenticated");
  if (signedOut.length > 0) {
    deps.stdout("  Installed but not signed in:\n");
    for (const snapshot of signedOut) deps.stdout(`${signInHint(snapshot)}\n`);
    deps.stdout("\n");
  }
  if (unmatched.length > 0 && importedUnscored.length === 0) {
    deps.stdout(`  Listed and matched by no default: ${unmatched.map(ref).join(", ")}. Score any of them with\n  \`braingate models add\`.\n\n`);
  }

  // 3. The one provider BrainGate cannot scope per invocation. Asked only where an acceptance
  //    would actually grant something, through the same test `providers accept` applies (ADR 0008).
  const accepted: string[] = [];
  const antigravity = installed.find((snapshot) => snapshot.providerId === "google");
  const store = new ProviderAcceptanceStore(state.providerAcceptancePath);
  // A current acceptance is not re-asked; an expired one is, because an expiry is a decision going
  // stale rather than a decision being revoked.
  const onRecord = store.find("google");
  const currentlyAccepted = onRecord !== null && new Date(onRecord.expiresAt).getTime() > Date.now();
  if (antigravity !== undefined && acceptanceNeededFor("google") && !currentlyAccepted) {
    deps.stdout(`  ${UNSCOPED_PROVIDER_RISK}\n\n`);
    const accept = await confirm(
      deps,
      "  Accept Antigravity as an unscoped provider for 30 days? [y/N] ",
      false,
      scripted.accept === undefined ? undefined : scripted.accept.includes("google"),
    );
    if (accept) {
      const record = store.accept("google");
      accepted.push("google");
      deps.stdout(`\n  Accepted google until ${record.expiresAt}. Undo with \`braingate providers revoke google\`.\n\n`);
    } else {
      deps.stdout("\n  Not accepted. Antigravity stays closed for the roles that need it; /providers shows which.\n\n");
    }
  }
  // Said whatever the answer was: acceptance is about what `agy` may reach on this machine, and the
  // DIRECT rules are about what a headless `agy` may do at all. They are different facts, and only
  // the operator can change the second one (ADR 0020).
  if (antigravity !== undefined) {
    const permissions = readAntigravityHeadlessPermissions({ env, workspace: deps.cwd });
    if (!permissions.reads || !permissions.shell) {
      deps.stdout([
        "  Antigravity runs headlessly only under its own permission rules. Yours do not have them:",
        `    ${permissions.path}`,
        `    permissions.allow: "${ANTIGRAVITY_READ_RULE}", "${ANTIGRAVITY_SHELL_RULE}"`,
        "  BrainGate never edits that file — it is your CLI's settings, and granting itself access",
        "  through them is exactly what it must not do. Add them yourself; /providers re-reads it.",
        "",
      ].join("\n"));
      deps.stdout("\n");
    }
  }

  // 4. How much review this workspace wants. Big or risky writes always get a reviewer; this is
  //    about the ordinary ones.
  const entries = catalog.load();
  const coverage = analyzeModelCoverage(entries);
  const reviewAlways = await confirm(deps, "  Require a reviewer on every write in this session? [y/N] ", false, scripted.reviewAlways);
  if (scope !== null) {
    updateSessionPreferences(sessionPreferencesPath(scope.storageDir), { reviewAlways, setupCompletedAt: new Date().toISOString() });
  }

  // Everything that was decided without asking, said out loud.
  deps.stdout([
    "",
    "  Assumed, and changeable:",
    "    policy `direct` — work happens in this workspace, where you can see it. /policy worktree changes it.",
    "    big writes (T3/T4 or high/critical risk) always run in an isolated worktree with a reviewer.",
    "    quota is read from each CLI's own reporting; BrainGate records no quota state of its own.",
    `    independent review: ${coverage.reviewerIndependence}${coverage.reviewerIndependence === "cross-provider" ? " — a reviewer can come from a different subscription than the writer." : " — sign a second CLI in for a genuinely independent reviewer."}`,
    `    reviewer on every write: ${reviewAlways ? "on" : "off"} — /review on|off changes it.`,
    "",
  ].join("\n"));

  // The same preflight line the session prints, so the wizard ends where the session begins.
  const header: string[] = [];
  await runDogfoodCli(["dogfood", "preflight"], {
    cwd: deps.cwd,
    stdout: (text) => header.push(text),
    stderr: (text) => header.push(text),
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.discoverAll === undefined ? {} : { discoverAll: deps.discoverAll }),
  });
  const preflight = firstLine(header.join(""));
  if (preflight.length > 0) deps.stdout(`  ${preflight}\n`);
  deps.stdout("  Editable any time: /setup, /models, /providers, /policy, /review.\n\n");

  return Object.freeze({
    registered: projectId !== null,
    projectId,
    adopted: Object.freeze(adopted.map(ref)),
    assumed: Object.freeze(assumedRows.map(ref)),
    kept: Object.freeze(kept.map(ref)),
    unscored: Object.freeze(importedUnscored.map(ref)),
    accepted: Object.freeze(accepted),
    reviewAlways,
    exitCode: 0,
  });
}
