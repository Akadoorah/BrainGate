import { findManifest } from "./manifest-path.js";
import { attachFromManifest } from "./project-attachment.js";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { conservativeTokenEstimate } from "@braingate/context";
import { CODEX_PROBE_VERSION } from "@braingate/shadow";
import { ProjectSnapshotProvider } from "@braingate/execution";
import type { NativeSessionResolver, TaskSnapshotProvider } from "@braingate/shadow";
import {
  BrainGateInvariantError,
  ProjectRegistry,
  TaskLedger,
  budgetFor,
  classifyTask,
  isTaskComplexity,
  quotaRefusalOf,
  type ProviderQuotaRefusal,
  type RegisteredProject,
  type TaskComplexity,
  type TaskReceipt,
  type TaskClassification,
  DEFAULT_EXECUTION_POLICY,
  executionPolicySpec,
  type ExecutionPolicyId,
} from "@braingate/core";
import {
  DogfoodStore,
  applyDogfoodPrior,
  initializeDogfoodProject,
  inspectGitRepository,
  repositoryReadiness,
} from "@braingate/dogfood";
import { GlobalQuotaStore, WINDOW_UTILIZATION_METRIC, recordPoolLoad, recordPoolSpend } from "@braingate/observability";
import { ModelCatalog, buildShadowTaskPlan, hydrateModelRegistry, resolveOperatorState, type OperatorStatePaths } from "@braingate/operator";
import { ModelListCache, NodeProbeRunner, PROVIDER_IDS, ProviderDiscovery, probeCliCapabilities, type ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, type ModelDefinition } from "@braingate/router";
import {
  CodexIsolationVerifier,
  GROK_WRITE_SANDBOX,
  ShadowDogfoodRunner,
  measuredFrom,
  shadowProviderRoleStatus,
  type CodexIsolationAttestation,
  type GrokIsolationAttestation,
  type GrokSandboxPolicy,
  type MeasuredCapabilities,
  type QuotaReading,
  type RoleActivity,
  type ShadowProcessExecutor,
  type SubscriptionAttestation,
} from "@braingate/shadow";
import { acceptedSubscriptions, codexIsolationStatusFor, configuredProvider, grokIsolationStatus, isolationCacheFor, loadAcceptances, type IsolationStatus } from "./provider-proof.js";
import { taskTitleFor } from "@braingate/security";
import { collectTaskMemory } from "./task-memory.js";
import { WriteDogfoodRunner, assertClaudeWriteEligible, buildWriteTaskPlan, type WriteProviderExecutor } from "@braingate/write";
import { applyInheritedFloor } from "@braingate/goals";
import { isUsableOutcome, projectFinalizer, recordedOutcomeOf, type RecordedOutcome } from "./finalization.js";

export interface DogfoodCliDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly discoverAll?: () => Promise<readonly ProviderSnapshot[]>;
  readonly verifyCodexIsolation?: (snapshot: ProviderSnapshot) => Promise<CodexIsolationAttestation>;
  readonly verifyGrokIsolation?: (snapshot: ProviderSnapshot) => Promise<GrokIsolationAttestation>;
  readonly executor?: ShadowProcessExecutor;
  readonly writeExecutor?: WriteProviderExecutor;
  /**
   * Where a read-primary run's project copy comes from; a test supplies a fake so it can assert what
   * the provider was pointed at without copying a real project.
   */
  readonly snapshotStore?: TaskSnapshotProvider;
  /**
   * Told which provider and model is working, as each role starts and finishes.
   *
   * The terminal's one question while a task runs is who is doing this right now. A control
   * plane that routes across four subscriptions and answers "working" has hidden the only thing
   * that made it different from running one CLI by hand.
   */
  readonly onRoleActivity?: (activity: RoleActivity) => void;
  /**
   * Told the model's prose as it is written.
   *
   * Only for the providers whose stream shape has been measured, and only the readable field
   * inside a schema-enforced answer — the fragments themselves are JSON.
   */
  readonly onText?: (text: string) => void;
  /** Told once per role, when the model starts reasoning before it says anything. */
  readonly onThinking?: () => void;
  /** What each installed build accepts, for tests that must not spawn probes. */
  readonly measureCapabilities?: () => Promise<Readonly<Record<string, MeasuredCapabilities>>>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /**
   * Asks the operator a single question and resolves to their answer, or to null when there
   * is nobody to ask. Injected so tests never depend on a terminal, and so a non-interactive
   * run fails with a usable message instead of waiting on stdin forever.
   */
  readonly ask?: (question: string) => Promise<string | null>;
  /**
   * Turns already exchanged in an interactive session, so a follow-up resolves against them.
   * Supplied only by the session; the flag interface never sets it, and nothing here is
   * persisted or promoted to memory.
   */
  readonly sessionTurns?: (contextTokenBudget: number) => readonly { readonly request: string; readonly answer: string }[];
  /**
   * The goal this request continues, as the layers a provider reads.
   *
   * M20. Supplied by the interactive session and absent for the flag interface — a one-shot command
   * continues nothing, and inventing a goal for it would make every scripted invocation a
   * conversation. It reaches the provider inside the payload's `context` field, beside project
   * memory and the session turns, and it is what makes a provider switch a continuation rather
   * than a fresh start.
   */
  readonly goalContext?: unknown;
  /** The goal and conversation the task this run creates is a work unit of. */
  readonly goalId?: string | null;
  readonly conversationId?: string | null;
  /**
   * The worker the operator named by hand, when there is one.
   *
   * A pin narrows which model is *considered* and nothing else — every eligibility gate still
   * applies, and an ineligible pin is refused rather than routed around. Supplied only by the
   * interactive session, which is the only surface where a person is choosing.
   */
  readonly pin?: { readonly providerId: string; readonly modelId: string } | undefined;
  /**
   * Asked per invocation whether this run continues a native provider session.
   *
   * Supplied by the session, which is the only layer that knows the goal a session belongs to. Absent,
   * nothing is pinned, nothing is resumed, and no session is persisted.
   */
  readonly nativeSession?: NativeSessionResolver | undefined;
  /**
   * The complexity floor of the goal this request continues.
   *
   * Supplied by the session that owns the goal rather than read from the goals store here: a task
   * surface takes a tier, not a second copy of the goal model. Absent, the request is classified
   * exactly as it was before M20, which is what the flag interface and every scripted call get.
   *
   * It is applied to the plan as well as the run, on purpose. A plan that routed a follow-up as a
   * standalone T1 while the run then inherited T3 would be describing a task nobody approved.
   */
  readonly inheritedComplexity?: TaskComplexity | null;
  /**
   * Told which `provider/model` actually served the run, once it has.
   *
   * Read from the same role-activity events the terminal already watches rather than derived a
   * second time, so what a turn is attributed to and what the operator saw happen cannot disagree.
   */
  readonly onTurnAttribution?: (attributedTo: readonly string[]) => void;
  /** Set by the interactive session, which has already introduced itself and shows its own prompt. */
  readonly quiet?: boolean;
}

export interface DogfoodCliResult {
  readonly exitCode: number;
  readonly data: unknown;
}

interface CodexIsolationStatus {
  readonly attempted: boolean;
  readonly eligible: boolean;
  readonly attestation: CodexIsolationAttestation | null;
  readonly reason: string | null;
}

function removeFlag(args: string[], name: string): boolean {
  let found = false;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (args[index] === name) { args.splice(index, 1); found = true; }
  }
  return found;
}

function takeOption(args: string[], name: string, required = false): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new BrainGateInvariantError("CLI_OPTION_REQUIRED", `Missing required option ${name}.`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new BrainGateInvariantError("CLI_OPTION_INVALID", `Option ${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function noExtraArgs(args: readonly string[]): void {
  if (args.length > 0) throw new BrainGateInvariantError("CLI_ARGUMENT_INVALID", `Unexpected CLI argument: ${args[0]}.`);
}

function safeError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof BrainGateInvariantError) return Object.freeze({ code: error.code, message: error.message });
  if (error instanceof RangeError) return Object.freeze({ code: "CLI_RANGE_ERROR", message: error.message });
  return Object.freeze({ code: "CLI_UNEXPECTED", message: "Unexpected BrainGate dogfood failure. Raw error details were suppressed." });
}

/**
 * Marks an error as one that happened after a task already existed.
 *
 * The question the operator needs answered is not which error this was but whether anything was
 * recorded for the attempt, and only the run path can know that. Tagged onto the error rather than
 * threaded through six signatures, and non-enumerable so it can never reach a serialized surface.
 */
const RECORDED_TASK = Symbol("braingate.recordedTask");

function markTaskRecorded(error: unknown): never {
  if (typeof error === "object" && error !== null) {
    Object.defineProperty(error, RECORDED_TASK, { value: true, enumerable: false, configurable: true });
  }
  throw error;
}

function taskWasRecorded(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[RECORDED_TASK] === true;
}

/**
 * Prints a result, and returns it.
 *
 * Returning is the point. Whether a caller asked for JSON decides how a result is *rendered*, not
 * what the result *is*: the interactive session reads a plan's classification and a run's task id
 * back out of `data`, and the earlier version handed it nothing whenever `--json` was absent, so the
 * session could not tell "the run recorded no task" from "the run's task id was never returned".
 * The two are different answers and the difference decides what the operator does next.
 */
/**
 * The execution policy this command runs under, from `--policy` or the DIRECT default.
 *
 * Parsed in one place so every command that runs a worker accepts the same word, and validated
 * against the exported list rather than a copy of it: `--policy direct` and `--policy snapshot` mean
 * the same thing wherever they are typed, and an unknown word is refused with the list.
 */
function policyOption(args: string[]): ExecutionPolicyId {
  const requested = takeOption(args, "--policy") ?? DEFAULT_EXECUTION_POLICY;
  return executionPolicySpec(requested).id;
}

function emit(json: boolean, data: unknown, human: string, stdout: (text: string) => void): void {
  stdout(json ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);
}

/**
 * A question function backed by the real terminal, or undefined when this run has no terminal
 * to ask (a pipe, CI, an editor task). Returning undefined rather than reading stdin anyway is
 * what keeps a scripted `braingate init` from hanging forever waiting for an answer.
 */
function terminalAsk(): ((question: string) => Promise<string | null>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return async (question: string): Promise<string | null> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(question); }
    catch { return null; }
    finally { rl.close(); }
  };
}

/**
 * Turns a directory name into a candidate project id: lowercase, non-alphanumerics collapsed
 * to single hyphens, trimmed to the registry's 64-character limit. Returns null when nothing
 * usable survives, in which case the operator is asked outright rather than given a guess.
 */
export function suggestedProjectId(directoryName: string): string | null {
  const slug = directoryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length === 0 ? null : slug;
}

/**
 * Resolves the project identity for `init`.
 *
 * The identity is the isolation boundary — memory, worktrees and telemetry are all scoped to
 * it — so BrainGate proposes one and has it confirmed rather than deciding silently. Explicit
 * flags skip the question entirely, which keeps scripted use unchanged, and a run with nobody
 * to ask fails with the flags to pass instead of blocking on stdin.
 */
async function resolveProjectIdentity(input: {
  readonly cwd: string;
  readonly projectId: string | null;
  readonly name: string | null;
  readonly ask: ((question: string) => Promise<string | null>) | undefined;
  readonly stdout: (text: string) => void;
  readonly quiet?: boolean;
}): Promise<{ readonly projectId: string; readonly name: string }> {
  if (input.projectId !== null && input.name !== null) return { projectId: input.projectId, name: input.name };

  const directory = basename(input.cwd);
  const suggestion = suggestedProjectId(directory);
  const missingFlags = new BrainGateInvariantError(
    "CLI_OPTION_REQUIRED",
    `Cannot ask for the project identity without a terminal. Pass --project-id <id> and --name <name>${suggestion === null ? "" : ` (suggested id: ${suggestion})`}.`,
  );
  if (input.ask === undefined) throw missingFlags;

  // A session has already introduced itself and explained the boundary, so it passes quiet:true
  // rather than have the operator read the same two sentences twice.
  if (input.quiet !== true) {
    input.stdout(`Registering the repository in ${directory} with BrainGate.\n`);
    input.stdout("The project id is the isolation boundary: memory, worktrees and telemetry are scoped to it.\n\n");
  }

  let projectId = input.projectId;
  if (projectId === null) {
    const answer = await input.ask(suggestion === null ? "Project id: " : `Project id [${suggestion}]: `);
    if (answer === null) throw missingFlags;
    const chosen = answer.trim().length === 0 ? suggestion : answer.trim();
    if (chosen === null) throw new BrainGateInvariantError("CLI_OPTION_REQUIRED", "A project id is required.");
    projectId = chosen;
  }

  let name = input.name;
  if (name === null) {
    const answer = await input.ask(`Display name [${directory}]: `);
    if (answer === null) throw missingFlags;
    name = answer.trim().length === 0 ? directory : answer.trim();
  }
  return { projectId, name };
}

function manifestOption(args: string[]): string { return takeOption(args, "--project") ?? ".brain/project.json"; }

/**
 * The project a `--rebind` is moving, read straight from the manifest.
 *
 * Not through the registry, deliberately: the registry resolves the manifest's repository, and a
 * rebind is precisely the case where that resolution fails — an unmounted drive, a moved directory.
 * The id and name are readable regardless, and they are what has to survive the move.
 */
function existingManifestIdentity(cwd: string, manifest: string): { readonly projectId: string; readonly name: string } | null {
  const path = findManifest(cwd, manifest);
  if (!existsSync(path)) throw new BrainGateInvariantError("PROJECT_REBIND_NO_MANIFEST", `--rebind moves an existing registration, and there is no manifest at ${manifest} here. Run \`braingate init --project-id <id>\` to register this checkout as a new project.`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new BrainGateInvariantError("PROJECT_REBIND_INVALID", "The existing .brain/project.json cannot be read, so there is no registration to move."); }
  const record = parsed as { readonly project_id?: unknown; readonly name?: unknown };
  if (typeof record.project_id !== "string" || typeof record.name !== "string") {
    throw new BrainGateInvariantError("PROJECT_REBIND_INVALID", "The existing .brain/project.json does not name a project, so there is no registration to move.");
  }
  return Object.freeze({ projectId: record.project_id, name: record.name });
}
function contextTokens(task: string): number { return Math.max(128, conservativeTokenEstimate(task) + 64); }

function attestations(copilotOauth: boolean, state: OperatorStatePaths): readonly SubscriptionAttestation[] {
  // An acceptance already carries the operator's statement about how that provider is billed,
  // so it does not need a second flag on every command.
  const accepted = acceptedSubscriptions(state);
  if (!copilotOauth) return Object.freeze(accepted);
  const observed = new Date();
  return Object.freeze([...accepted, Object.freeze({
    providerId: "github-copilot",
    mode: "subscription",
    source: "user-confirmed-oauth",
    observedAt: observed.toISOString(),
    expiresAt: new Date(observed.getTime() + 60 * 60 * 1000).toISOString(),
  })]);
}

/** Discovery for one command; see the note on the same helper in cli.ts. */
async function discovery(deps: DogfoodCliDependencies, state: OperatorStatePaths): Promise<readonly ProviderSnapshot[]> {
  if (deps.discoverAll !== undefined) return await deps.discoverAll();
  const modelCache = new ModelListCache({ path: resolve(state.globalDir, "model-lists.json") });
  return await new ProviderDiscovery(undefined, { modelCache }).discoverAll();
}

function configuredOpenAi(state: OperatorStatePaths): boolean {
  return new ModelCatalog(state.modelCatalogPath).load().some((entry) => entry.configured && entry.providerId === "openai");
}

async function codexIsolationStatus(
  snapshots: readonly ProviderSnapshot[],
  deps: DogfoodCliDependencies,
  env: NodeJS.ProcessEnv,
  shouldAttempt: boolean,
  state: OperatorStatePaths,
  /** Read-primary needs the contract that proves the denied writes; the staged roles need the profile. */
  minProbeVersion?: string,
): Promise<IsolationStatus<CodexIsolationAttestation>> {
  return await codexIsolationStatusFor({
    snapshots,
    env,
    shouldAttempt,
    cache: isolationCacheFor(state),
    ...(minProbeVersion === undefined ? {} : { minProbeVersion }),
    ...(deps.verifyCodexIsolation === undefined ? {} : { verify: deps.verifyCodexIsolation }),
  });
}

/** Grok's sandbox, re-proved for this command; see apps/cli/src/provider-proof.ts. */
async function grokProof(
  state: OperatorStatePaths,
  snapshots: readonly ProviderSnapshot[],
  deps: DogfoodCliDependencies,
  env: NodeJS.ProcessEnv,
  project?: RegisteredProject,
  /** The write profile earns its own proof; the read-only staged profile is the default. */
  policy?: GrokSandboxPolicy,
  /** `snapshot-read` earns the proof for a read-primary run on a project copy. */
  mode?: "staged" | "snapshot-read",
): Promise<Awaited<ReturnType<typeof grokIsolationStatus>>> {
  return await grokIsolationStatus({
    snapshots,
    env,
    shouldAttempt: configuredProvider(new ModelCatalog(state.modelCatalogPath).load(), "xai"),
    cache: isolationCacheFor(state),
    ...(project === undefined ? {} : { project }),
    ...(policy === undefined ? {} : { policy }),
    ...(mode === undefined ? {} : { mode }),
    ...(deps.verifyGrokIsolation === undefined ? {} : { verify: deps.verifyGrokIsolation }),
  });
}


/**
 * Feeds what a task spent back into the pool-load signal.
 *
 * The receipt already says which model burned what, natively. Until this, that number was only
 * ever read by a person: nothing turned it into a reason to route the next task differently,
 * which is why every role went to the strongest model every time.
 *
 * Only the pool, the provider and a count leave the project. A pool is shared across every
 * project on the machine, so its load has to be global — the ledger it comes from deliberately
 * is not.
 */
function recordSpendFromReceipt(state: OperatorStatePaths, usage: readonly { readonly provider: string; readonly model: string | null; readonly metric: string; readonly value: number | null; readonly evidence: string }[], models: readonly ModelDefinition[]): void {
  const poolOf = new Map(models.map((definition) => [`${definition.providerId}\u0000${definition.modelId}`, definition.quotaPool]));
  const spend = new Map<string, { provider: string; quotaPool: string; tokens: number }>();
  for (const row of usage) {
    // Only what a provider counted for itself. An estimate fed back into routing would become a
    // reason to move work, and the reason would be a guess.
    if (row.metric !== "provider_tokens" || row.evidence !== "native" || row.value === null || row.model === null) continue;
    const quotaPool = poolOf.get(`${row.provider}\u0000${row.model}`);
    if (quotaPool === undefined) continue;
    const key = `${row.provider}\u0000${quotaPool}`;
    const current = spend.get(key) ?? { provider: row.provider, quotaPool, tokens: 0 };
    current.tokens += row.value;
    spend.set(key, current);
  }
  if (spend.size === 0) return;
  const store = new GlobalQuotaStore(state.globalDir);
  try {
    recordPoolSpend(store, [...spend.values()]);
    recordPoolLoad(store);
  } finally { store.close(); }
}

function runtimeFor(state: OperatorStatePaths, snapshots: readonly ProviderSnapshot[]): { readonly router: CapabilityRouter; readonly runtimes: readonly unknown[] } {
  const entries = new ModelCatalog(state.modelCatalogPath).load();
  if (!entries.some((entry) => entry.configured)) throw new BrainGateInvariantError("MODEL_CATALOG_EMPTY", "No configured models are available. Import/discover then add scored model definitions before dogfood execution.");
  const quota = new GlobalQuotaStore(state.globalDir);
  try {
    // The refusal backoff is applied here, where a task is about to be routed: a pool a provider
    // refused minutes ago is avoided before the call rather than after it. It does not touch
    // availability — it is a local decision to wait, with its own expiry.
    const hydrated = hydrateModelRegistry({ entries, providers: snapshots, quota: quota.latest(), backoff: quota.activeRefusalBackoffs() });
    return Object.freeze({ router: new CapabilityRouter(hydrated.registry), runtimes: hydrated.runtimes });
  } finally { quota.close(); }
}

function resolveWriteRepository(project: RegisteredProject, cwd: string, requested: string | undefined): string {
  if (requested === undefined) {
    if (project.repositories.length !== 1) throw new BrainGateInvariantError("CLI_REPOSITORY_REQUIRED", "Multi-repository projects require explicit --repo for dogfood writes.");
    return project.repositories[0]!;
  }
  let candidate: string;
  try { candidate = realpathSync.native(resolve(cwd, requested)); }
  catch { throw new BrainGateInvariantError("CLI_REPOSITORY_INVALID", "--repo does not resolve to an accessible registered repository."); }
  if (!project.repositories.includes(candidate)) throw new BrainGateInvariantError("CLI_REPOSITORY_INVALID", "--repo is not registered to the selected project.");
  return candidate;
}

function classificationView(predicted: TaskClassification, effective: TaskClassification, prior: ReturnType<DogfoodStore["derivePrior"]>, applied: boolean) {
  return Object.freeze({ predicted: { complexity: predicted.complexity, risk: predicted.risk, confidence: predicted.confidence, ruleVersion: predicted.ruleVersion }, effective: { complexity: effective.complexity, risk: effective.risk, confidence: effective.confidence, ruleVersion: effective.ruleVersion }, prior, applied });
}

/**
 * How a recorded outcome reads on one line.
 *
 * `null` means the task has no readable finalization record — still running, or stopped between
 * finishing and writing the record. That is a different fact from an outcome of UNKNOWN, which is
 * BrainGate having recorded that it could not tell what happened; the first has a next step and the
 * second does not.
 */
function describeOutcome(recorded: RecordedOutcome | null): string {
  if (recorded === null) return "not recorded · run `braingate tasks reconcile`";
  return recorded.failureKind === null ? recorded.outcome : `${recorded.outcome} (${recorded.failureKind})`;
}

/**
 * The routed roles, as one line.
 *
 * A role that appears twice is numbered rather than printed twice under the same name: a task
 * can now spend two subscriptions on the approach, and "planner=x · planner=y" reads like a
 * rendering bug rather than the point.
 */
export function roleLine(roles: readonly { readonly role: string; readonly model: { readonly providerId: string; readonly modelId: string } }[]): string {
  const counts = new Map<string, number>();
  for (const role of roles) counts.set(role.role, (counts.get(role.role) ?? 0) + 1);
  const seen = new Map<string, number>();
  return roles.map((role) => {
    const index = (seen.get(role.role) ?? 0) + 1;
    seen.set(role.role, index);
    const name = (counts.get(role.role) ?? 0) > 1 ? `${role.role}-${String(index)}` : role.role;
    return `${name}=${role.model.providerId}/${role.model.modelId}`;
  }).join(" · ");
}

/**
 * Records what a provider said about its own remaining window.
 *
 * Written as `window_utilization` with `unknown` status, and that pairing is the whole point. The
 * number is real — the provider reported it — but *what it means for the pool right now* is not
 * something BrainGate knows: the window it describes may already have reset, and whether the
 * provider would serve the next call is a question only the provider can answer.
 *
 * This used to be written as `pressure` with a status of `healthy` or `exhausted` derived from
 * whether the call it rode along with was served. That turned a utilisation reading into a health
 * claim, and routing acted on it: a pool at 47% could be skipped as though it had refused.
 */
/**
 * Applies what a finished task taught about refusals, in both directions.
 *
 * A pool a provider refused is avoided for a short, bounded time (a local decision, never a quota
 * claim), and a pool that just served a call has any backoff superseded — a success is the evidence
 * that ends the policy.
 *
 * Both are read from the task's own events rather than from the thrown error, so the policy can only
 * describe facts the ledger already holds. It is *not* written in the same transaction as those facts,
 * and cannot be: the ledger and this store are separate databases in WAL mode. A hard kill between
 * them loses the backoff — one redundant provider probe on a later task — and never touches quota
 * truth or the task's own record. Re-recording the same refusal is idempotent, because the state is
 * decided by observation time rather than by how many times something was written.
 */
function recordRefusalBackoffs(state: OperatorStatePaths, receipt: TaskReceipt, providerCalls: readonly { readonly providerId: string; readonly modelId: string; readonly quotaPool: string; readonly completed: boolean }[]): void {
  const refusals = refusalsIn(receipt.events);
  const served = providerCalls.filter((call) => call.completed);
  if (refusals.length === 0 && served.length === 0) return;
  const store = new GlobalQuotaStore(state.globalDir);
  try {
    for (const refusal of refusals) {
      store.recordRefusalBackoff({
        provider: refusal.providerId,
        quotaPool: refusal.quotaPool,
        reason: refusal.reason,
        detail: refusal.detail,
        sourceTaskId: receipt.task.taskId,
      });
    }
    for (const call of served) {
      store.clearRefusalBackoff({ provider: call.providerId, quotaPool: call.quotaPool, sourceTaskId: receipt.task.taskId });
    }
  } finally { store.close(); }
}

/** Every distinct refusal this task recorded, by pool: a task may have been refused more than once. */
function refusalsIn(events: TaskReceipt["events"]): readonly ProviderQuotaRefusal[] {
  const seen = new Map<string, ProviderQuotaRefusal>();
  for (const event of events) {
    if (event.kind !== "shadow.provider.failed" && event.kind !== "shadow.provider.quota_refused") continue;
    const payload = typeof event.payload === "object" && event.payload !== null ? (event.payload as { readonly quotaRefusal?: unknown }) : null;
    const refusal = quotaRefusalOf({ quotaRefusal: payload?.quotaRefusal });
    if (refusal === null) continue;
    seen.set(`${refusal.providerId}\u0000${refusal.quotaPool}`, refusal);
  }
  return Object.freeze([...seen.values()]);
}

/** Pools whose provider actually answered in this task — the evidence that ends a backoff. */
function servedPools(events: TaskReceipt["events"]): readonly { readonly providerId: string; readonly modelId: string; readonly quotaPool: string; readonly completed: boolean }[] {
  const completed = new Set<string>();
  const started = new Map<string, { providerId: string; modelId: string; quotaPool: string }>();
  for (const event of events) {
    if (event.kind !== "shadow.provider.started" && event.kind !== "shadow.provider.completed") continue;
    const payload = typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : null;
    if (payload === null) continue;
    const providerId = typeof payload.provider === "string" ? payload.provider : null;
    const modelId = typeof payload.model === "string" ? payload.model : null;
    const quotaPool = typeof payload.quotaPool === "string" ? payload.quotaPool : null;
    if (providerId === null || modelId === null || quotaPool === null) continue;
    started.set(`${providerId}\u0000${modelId}`, { providerId, modelId, quotaPool });
    if (event.kind === "shadow.provider.completed") completed.add(`${providerId}\u0000${modelId}`);
  }
  return Object.freeze([...started.entries()].map(([key, call]) => Object.freeze({ ...call, completed: completed.has(key) })));
}

/** The single task this invocation just ran, read from the ledger rather than guessed at. */
function taskJustRun(ledger: TaskLedger, preexistingTaskId: string | null): TaskReceipt | null {
  const newest = ledger.listTasks()[0];
  if (newest === undefined || newest.taskId === preexistingTaskId) return null;
  return ledger.receipt(newest.taskId);
}

function recordQuotaReading(state: OperatorStatePaths, readings: readonly (QuotaReading & { readonly quotaPool: string })[]): void {
  if (readings.length === 0) return;
  // Every window is kept, because a receipt should be able to say what the provider reported.
  // Which of them decides a routing hint is the reader's question, and the reader takes the fullest:
  // a five-hour window at 0.9 matters whatever the weekly figure says.
  const store = new GlobalQuotaStore(state.globalDir);
  try {
    for (const reading of readings) {
      store.record({
        provider: reading.providerId,
        quotaPool: reading.quotaPool,
        metric: WINDOW_UTILIZATION_METRIC,
        window: reading.window,
        value: reading.utilization,
        unit: "ratio",
        resetAt: reading.resetAt,
        // The one status worth persisting is a window the provider itself reported as refused: it
        // is the provider's own words, it names the window, and it expires with that window's
        // reset. Everything else is a level rather than a verdict — whether a pool will serve the
        // *next* call is not something a utilisation number can answer, and "it served this one"
        // is not evidence about the next.
        status: reading.blocked ? "exhausted" : "unknown",
        evidence: "native",
        source: "provider-rate-limit-event",
      });
    }
  } finally { store.close(); }
}

/**
 * What each installed CLI's own help says it accepts, in the terms a grant reasons about.
 *
 * Free: help text, no prompt, no model. It runs alongside discovery so a profile's declaration
 * about a flag can be narrowed by what this build actually has — the difference between a run
 * that is refused here with a reason and one that fails at the provider with a flag error.
 */
async function measuredCapabilities(deps: DogfoodCliDependencies): Promise<Readonly<Record<string, MeasuredCapabilities>>> {
  if (deps.measureCapabilities !== undefined) return await deps.measureCapabilities();
  const runner = new NodeProbeRunner();
  const entries = await Promise.all(PROVIDER_IDS.map(async (providerId) => {
    try {
      const report = await probeCliCapabilities({ providerId, runner });
      return [providerId, measuredFrom(report)] as const;
    } catch {
      // A probe that could not run leaves the profile's declaration standing, which is what
      // `unknown` already means everywhere else here.
      return null;
    }
  }));
  return Object.freeze(Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)));
}

async function runPreflight(args: string[], deps: DogfoodCliDependencies, cwd: string, env: NodeJS.ProcessEnv, json: boolean, stdout: (text: string) => void): Promise<DogfoodCliResult> {
  const state = resolveOperatorState(env);
  const manifest = manifestOption(args);
  noExtraArgs(args);
  const { project, scope } = attachFromManifest(state, manifest, cwd);
  const repositories = project.repositories.map(inspectGitRepository);
  const snapshots = await discovery(deps, state);
  const catalog = new ModelCatalog(state.modelCatalogPath).load();
  const configured = catalog.filter((entry) => entry.configured);
  const isolation = await codexIsolationStatus(snapshots, deps, env, configured.some((entry) => entry.providerId === "openai"), state, CODEX_PROBE_VERSION);
  const grok = await grokProof(state, snapshots, deps, env, project);
  const acceptances = loadAcceptances(state);
  const roleStatus = (providerId: ProviderSnapshot["providerId"], role: "primary" | "reviewer") => {
    const acceptance = acceptances.find((item) => item.providerId === providerId);
    return shadowProviderRoleStatus(providerId, role, acceptance === undefined ? {} : { acceptance });
  };
  const providerById = new Map<string, ProviderSnapshot>(snapshots.map((snapshot) => [snapshot.providerId, snapshot]));

  const askCandidates = configured.filter((entry) => {
    const snapshot = providerById.get(entry.providerId);
    return snapshot !== undefined && snapshot.available.value === true && snapshot.authState.value === "authenticated" && snapshot.authMode.value === "subscription" && roleStatus(snapshot.providerId, "primary").enabled;
  });
  let writeCandidate = false;
  for (const entry of configured) {
    if (entry.providerId !== "anthropic" || !entry.configured || !entry.definition.writeCapable) continue;
    const snapshot = providerById.get("anthropic");
    if (snapshot === undefined) continue;
    try {
      assertClaudeWriteEligible(snapshot, { providerId: snapshot.providerId, modelId: entry.modelId, quotaPool: entry.definition.quotaPool });
      writeCandidate = true;
    } catch { /* reported as unavailable below */ }
  }
  const cleanForWrite = repositories.every((repo) => repo.clean);
  // A repository created a moment ago has a branch and no commit. Worktree writes branch from
  // a commit, so they cannot start yet — and saying that plainly beats letting the write path
  // fail later on `HEAD`.
  const uncommitted = repositories.filter((repo) => repo.head === null);
  const reviewerCandidates = configured.filter((entry) => {
    const snapshot = providerById.get(entry.providerId);
    if (snapshot === undefined || !roleStatus(snapshot.providerId, "reviewer").enabled) return false;
    if (snapshot.providerId === "openai") return isolation.eligible;
    if (snapshot.providerId === "xai") return grok.eligible;
    return snapshot.authState.value === "authenticated" && snapshot.authMode.value === "subscription";
  });
  const blockers: string[] = [];
  if (configured.length === 0) blockers.push("No scored models are configured in the model catalog.");
  if (askCandidates.length === 0) blockers.push("No authenticated configured model is eligible as a read-only primary.");
  if (!writeCandidate) blockers.push("No authenticated configured Claude model is eligible for M11 restricted writes.");
  if (!cleanForWrite) blockers.push("At least one registered repository is dirty; worktree writes require a clean source checkout.");
  if (uncommitted.length > 0) blockers.push("No commit yet in this repository; make a first commit before asking for a change, since worktree writes branch from one. Questions work now.");

  const data = Object.freeze({
    project: { projectId: project.projectId, name: project.name, manifest: resolve(cwd, manifest) },
    repositories,
    catalog: { entries: catalog.length, configured: configured.length, unscored: catalog.length - configured.length },
    providers: snapshots.map((snapshot) => ({ providerId: snapshot.providerId, available: snapshot.available.value, version: snapshot.version.value, authState: snapshot.authState.value, authMode: snapshot.authMode.value })),
    ask: { ready: askCandidates.length > 0, candidates: askCandidates.map((entry) => `${entry.providerId}/${entry.modelId}`) },
    write: { ready: writeCandidate && cleanForWrite && uncommitted.length === 0, primaryReady: writeCandidate, sourceClean: cleanForWrite, reviewerReady: reviewerCandidates.length > 0, reviewerCandidates: reviewerCandidates.map((entry) => `${entry.providerId}/${entry.modelId}`) },
    codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason },
    grokIsolation: { attempted: grok.attempted, eligible: grok.eligible, reason: grok.reason },
    acceptedProviders: acceptances.map((item) => item.providerId),
    blockers,
    providerModelCalls: 0,
  });
  emit(json, data, `Dogfood preflight ${project.projectId}: ask=${data.ask.ready ? "ready" : "blocked"} · write=${data.write.ready ? "ready" : "blocked"} · configured=${configured.length} · model calls=0${blockers.length > 0 ? `\n${blockers.map((item) => `- ${item}`).join("\n")}` : ""}`, stdout);
  return Object.freeze({ exitCode: data.ask.ready ? 0 : 1, data });
}

async function runAsk(args: string[], deps: DogfoodCliDependencies, cwd: string, env: NodeJS.ProcessEnv, json: boolean, stdout: (text: string) => void): Promise<DogfoodCliResult> {
  const action = args.shift();
  if (action !== "plan" && action !== "run") throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "dogfood ask requires plan or run.");
  const manifest = manifestOption(args);
  const policy = policyOption(args);
  const task = takeOption(args, "--task", true)!;
  const execute = removeFlag(args, "--execute");
  const optionalReview = removeFlag(args, "--review");
  const copilotOauth = removeFlag(args, "--attest-copilot-oauth");
  noExtraArgs(args);
  if (action === "plan" && execute) throw new BrainGateInvariantError("CLI_EXECUTE_INVALID", "--execute is valid only with dogfood ask run.");

  const state = resolveOperatorState(env);
  const oauth = attestations(copilotOauth, state);
  const { project, scope } = attachFromManifest(state, manifest, cwd);
  const snapshots = await discovery(deps, state);
  const runtime = runtimeFor(state, snapshots);
  const store = new DogfoodStore(scope.project);
  try {
    const predicted = classifyTask({ text: task, mode: "ask" });
    const prior = store.derivePrior("ask");
    const adaptive = applyDogfoodPrior(predicted, prior);
    // The goal this request continues, applied after the project prior so both the plan and the run
    // are priced for the work rather than for the sentence. M20.
    const floor = deps.inheritedComplexity ?? null;
    const effective = floor === null ? adaptive.effective : applyInheritedFloor(adaptive.effective, floor);
    const budget = budgetFor(effective, { writeRequested: false });
    const requiredContextTokens = contextTokens(task);
    const memory = collectTaskMemory(project, task, budget.maxContextTokens);
    const context = Object.freeze({
      projectId: project.projectId,
      scope: "dogfood-project-read-only",
      access: "read-only",
      // Canonical memory only. Proposals become canonical through `memory promote`, which
      // requires explicit evidence; surfacing them here would route around that gate.
      memory: memory.records,
      // The session's earlier turns: kept with the project for a few hours, redacted, and never
      // promoted to memory.
      session: deps.sessionTurns?.(budget.maxContextTokens) ?? [],
      // M20 layer 2 and 3: the goal this request continues, and where its detail lives. Absent for
      // the flag interface, which continues nothing.
      ...(deps.goalContext === undefined ? {} : { goal: deps.goalContext }),
    });
    const needsReview = budget.reviewerPolicy === "required" || (budget.reviewerPolicy === "optional" && optionalReview);
    // A review needs Codex's proof, and so does a read primary on a project copy: one self-test
    // answers both, so the probe runs whenever Codex is configured rather than only before a review.
    const isolation = await codexIsolationStatus(snapshots, deps, env, configuredOpenAi(state), state, CODEX_PROBE_VERSION);
    const codexIsolation = isolation.attestation ?? undefined;
    const grok = await grokProof(state, snapshots, deps, env, project);
    const grokIsolation = grok.attestation ?? undefined;
    // A read-primary run on a project copy executes from a BrainGate-owned Grok home with no operator
    // plugins, which is a different proof from the staged one. Earned here, on the same terms.
    const grokSnapshot = await grokProof(state, snapshots, deps, env, project, undefined, "snapshot-read");
    const grokSnapshotIsolation = grokSnapshot.attestation ?? undefined;
    const acceptances = loadAcceptances(state);
    const measured = await measuredCapabilities(deps);
    const plan = buildShadowTaskPlan({ project: scope.project, cwd, router: runtime.router, providers: snapshots, measured, nativeHarness: policy === "direct", attestations: oauth, task, context, classification: effective, budget, requiredContextTokens, optionalReview, acceptances, ...(deps.pin === undefined ? {} : { pin: deps.pin }), ...(codexIsolation === undefined ? {} : { codexIsolation }), ...(grokIsolation === undefined ? {} : { grokIsolation }), ...(grokSnapshotIsolation === undefined ? {} : { grokSnapshotIsolation }) });
    const view = classificationView(predicted, effective, prior, adaptive.applied);
    // The plan, in both readings the operator gets. `summary` and `grantLines` are the text the
    // terminal prints; `complexity`, `risk`, `promptComplexity` and `roleLines` are the same facts as
    // structure, so a caller that reads the plan back — the interactive session does — gets the
    // classification and the grants the plan actually used rather than a re-parse of its prose.
    const planData = Object.freeze({
      classification: view,
      complexity: effective.complexity,
      risk: effective.risk,
      promptComplexity: predicted.complexity,
      summary: `${effective.complexity}/${effective.risk}${adaptive.applied ? " · project prior applied" : ""} · ${roleLine(plan.roles)}`,
      grantLines: Object.freeze(plan.roles.map((role, index) => {
        const grant = role.invocation.grant;
        const refused = grant.refused.map((item) => item.capability).join(", ");
        const name = roleLine(plan.roles).split(" · ")[index]?.split("=")[0] ?? role.role;
        return Object.freeze(`${name}: ${grant.granted.join(", ")}${refused.length === 0 ? "" : ` · refused ${refused}`}`);
      })),
      budget,
      roles: plan.roles.map((role) => ({ role: role.role, model: role.model, invocation: role.invocation })),
      providerCallsOnPlan: 0,
    });

    if (action === "plan" || !execute) {
      const data = { ...planData, codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason } };
      emit(json, data, [
        planData.summary,
        // What each role may do, and what it asked for and did not get. Read before the run,
        // where "the planner wanted the network and nobody accepted it" is still actionable.
        ...planData.grantLines.map((line) => `  ${line}`),
        "Zero provider model calls executed.",
      ].join("\n"), stdout);
      return Object.freeze({ exitCode: 0, data });
    }

    // Collected during the run and written once it ends: a provider reports every window on
    // every call, and only the fullest of them should decide where the next task goes.
    const pendingQuotaReadings: (QuotaReading & { readonly quotaPool: string })[] = [];
    const ledger = new TaskLedger(scope.project);
    // Whatever was newest before this invocation, so the task this run created can be identified on
    // the failure path — a refusal ends the run, and its backoff must be applied anyway.
    const beforeTaskId = ledger.listTasks()[0]?.taskId ?? null;
    // Which provider and model actually served this run. Collected from the role-activity stream the
    // terminal already receives, so the turn's attribution is a reading rather than a second guess,
    // and deduplicated because a task may spend several phases on the same model.
    const servedBy: string[] = [];
    try {
      const runner = new ShadowDogfoodRunner({ project: scope.project, ledger, finalizer: projectFinalizer({ project: scope.project, ledger, store }), router: runtime.router, snapshots, attestations: oauth, acceptances, nativeHarness: policy === "direct", snapshotStore: deps.snapshotStore ?? new ProjectSnapshotProvider(scope.project), ...(codexIsolation === undefined ? {} : { codexIsolation }), ...(grokIsolation === undefined ? {} : { grokIsolation }), ...(grokSnapshotIsolation === undefined ? {} : { grokSnapshotIsolation }), ...(deps.executor === undefined ? {} : { executor: deps.executor }), onRoleActivity: (activity) => {
        if (activity.stage === "started") {
          const attribution = `${activity.provider}/${activity.model}`;
          if (!servedBy.includes(attribution)) servedBy.push(attribution);
        }
        deps.onRoleActivity?.(activity);
      }, ...(deps.onText === undefined ? {} : { onText: deps.onText }), ...(deps.onThinking === undefined ? {} : { onThinking: deps.onThinking }), onQuotaReading: (reading) => { pendingQuotaReadings.push(reading); }, ...(deps.pin === undefined ? {} : { pin: deps.pin }), ...(deps.nativeSession === undefined ? {} : { nativeSession: deps.nativeSession }) });
      const result = await runner.run({ title: taskTitleFor(task), task, cwd, classification: effective, budget, requiredContextTokens, context, observation: { predicted, effective, prior }, ...(deps.goalId === undefined ? {} : { goalId: deps.goalId }), ...(deps.conversationId === undefined ? {} : { conversationId: deps.conversationId }), contextSummary: { memoryRecords: memory.recordCount, explicitCandidates: 0, includedItems: 1 + memory.recordCount, estimatedTokens: requiredContextTokens + memory.estimatedTokens, truncatedItems: memory.truncated, sourceLabels: memory.recordCount === 0 ? ["dogfood-minimal-context"] : ["dogfood-minimal-context", "project-canonical-memory"] }, optionalReview, dryRun: false });
      if (result.taskReceipt === null || result.taskId === null) throw new BrainGateInvariantError("DOGFOOD_RECEIPT_MISSING", "Executed dogfood ask did not produce a task receipt.");
      deps.onTurnAttribution?.(Object.freeze([...servedBy]));
      // The runner recorded the outcome, the result and the observation; this reads them back
      // rather than deciding again. A second derivation here is how the screen and the ledger end
      // up disagreeing about the same task.
      const recorded = recordedOutcomeOf(result.taskReceipt);
      const observationSequence = store.find(result.taskId)?.sequence ?? null;
      recordSpendFromReceipt(state, result.taskReceipt.usage, new ModelCatalog(state.modelCatalogPath).configured());
      recordQuotaReading(state, pendingQuotaReadings);
      recordRefusalBackoffs(state, result.taskReceipt, servedPools(result.taskReceipt.events));
      const data = Object.freeze({ plan: planData, taskId: result.taskId, observationSequence, outcome: recorded?.outcome ?? null, reviewStatus: recorded?.reviewStatus ?? null, failureKind: recorded?.failureKind ?? null, answer: result.workflow?.finalOutput ?? null, usage: result.taskReceipt.usage });
      emit(json, data, `${result.workflow?.finalOutput ?? "No answer returned."}\n\nTask ${result.taskId} · observed=${observationSequence ?? "none"} · outcome=${describeOutcome(recorded)}`, stdout);
      return Object.freeze({ exitCode: recorded !== null && isUsableOutcome(recorded.outcome) ? 0 : 1, data });
    } catch (error) {
      try {
        // Best effort by design: the ledger already holds the refusal, so a process killed before this
        // runs costs at most one more probe by a later task. It never changes what this task recorded.
        const receipt = taskJustRun(ledger, beforeTaskId);
        if (receipt !== null) recordRefusalBackoffs(state, receipt, servedPools(receipt.events));
      } catch { /* a backoff that cannot be recorded must not replace the run's own failure */ }
      // The task exists and the runner has already recorded what became of it, so this is an
      // execution failure rather than a preflight one. Marked so the operator is never told that
      // nothing was recorded when the record exists.
      markTaskRecorded(error);
    } finally { ledger.close(); }
  } finally { store.close(); }
}

async function runWrite(args: string[], deps: DogfoodCliDependencies, cwd: string, env: NodeJS.ProcessEnv, json: boolean, stdout: (text: string) => void): Promise<DogfoodCliResult> {
  const action = args.shift();
  if (action !== "plan" && action !== "run") throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "dogfood write requires plan or run.");
  const manifest = manifestOption(args);
  const task = takeOption(args, "--task", true)!;
  const requestedRepo = takeOption(args, "--repo");
  const baseRef = takeOption(args, "--base") ?? "HEAD";
  const execute = removeFlag(args, "--execute");
  const review = !removeFlag(args, "--no-review");
  const copilotOauth = removeFlag(args, "--attest-copilot-oauth");
  // Read before the leftover-argument check: a flag the command accepts is not an extra argument.
  const policy = policyOption(args);
  noExtraArgs(args);
  if (action === "plan" && execute) throw new BrainGateInvariantError("CLI_EXECUTE_INVALID", "--execute is valid only with dogfood write run.");

  const state = resolveOperatorState(env);
  const oauth = attestations(copilotOauth, state);
  const { project, scope } = attachFromManifest(state, manifest, cwd);
  // Under DIRECT the write happens in the workspace itself, so the path it runs in is the workspace
  // the operator selected rather than a registered repository picked for a worktree of it.
  const repositoryPath = policy === "direct" || policy === "unattended"
    ? scope.workspacePath
    : resolveWriteRepository(project, cwd, requestedRepo);
  const snapshots = await discovery(deps, state);
  const runtime = runtimeFor(state, snapshots);
  const store = new DogfoodStore(scope.project);
  try {
    const predicted = classifyTask({ text: task, mode: "write" });
    const prior = store.derivePrior("write");
    const adaptive = applyDogfoodPrior(predicted, prior);
    // A write that continues a goal inherits the goal's floor on the same terms as a question. M20.
    const floor = deps.inheritedComplexity ?? null;
    const effective = floor === null ? adaptive.effective : applyInheritedFloor(adaptive.effective, floor);
    const budget = budgetFor(effective, { writeRequested: true });
    const requiredContextTokens = contextTokens(task);
    const isolation = await codexIsolationStatus(snapshots, deps, env, review && configuredOpenAi(state), state, CODEX_PROBE_VERSION);
    const codexIsolation = isolation.attestation ?? undefined;
    const grok = await grokProof(state, snapshots, deps, env, project);
    const grokIsolation = grok.attestation ?? undefined;
    // A Grok write runs under a different sandbox profile than a Grok review, so it earns a
    // different proof. Both self-tests are free; neither stands in for the other.
    const grokWrite = await grokProof(state, snapshots, deps, env, project, GROK_WRITE_SANDBOX);
    const grokWriteIsolation = grokWrite.attestation ?? undefined;
    const acceptances = loadAcceptances(state);
    const plan = buildWriteTaskPlan({ policy, router: runtime.router, providers: snapshots, attestations: oauth, acceptances, ...(deps.pin === undefined ? {} : { pin: deps.pin }), ...(codexIsolation === undefined ? {} : { codexIsolation }), ...(grokIsolation === undefined ? {} : { grokIsolation }), ...(grokWriteIsolation === undefined ? {} : { grokWriteIsolation }), classification: effective, budget, requiredContextTokens, repositoryPath, baseRef, review });
    const view = classificationView(predicted, effective, prior, adaptive.applied);
    // The same structural fields the read plan carries, so a caller that continues a goal reads one
    // shape whichever mode the request took. `summary` is what the terminal prints; the tiers are
    // what the plan *used*, which is what the session's goal line has to agree with.
    const planData = Object.freeze({
      classification: view,
      complexity: effective.complexity,
      risk: effective.risk,
      promptComplexity: predicted.complexity,
      summary: `${effective.complexity}/${effective.risk}${adaptive.applied ? " · project prior applied" : ""} · ${roleLine(plan.roles)}`,
      // No grants here: a write role carries a workspace rather than a tool grant, and inventing an
      // empty list would let a reader conclude the roles were granted nothing.
      budget,
      repositoryPath,
      baseRef,
      roles: plan.roles.map((role) => ({ role: role.role, model: role.model, workspace: role.workspace })),
      providerCallsOnPlan: 0,
      createsWorktree: false,
      mergeAvailable: false,
    });

    if (action === "plan" || !execute) {
      const data = { ...planData, codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason }, approvalRequired: true };
      emit(json, data, [
        planData.summary,
        // Which workspace each write role runs in, which is this mode's equivalent of a grant: it
        // says where a change would land, and that the operator's checkout is not on the list.
        ...plan.roles.map((role) => `  ${role.role}: ${role.workspace} · ${role.model.providerId}/${role.model.modelId}`),
        "Zero provider model calls. Zero worktrees. Merge unavailable.",
      ].join("\n"), stdout);
      return Object.freeze({ exitCode: 0, data });
    }

    const ledger = new TaskLedger(scope.project);
    const beforeTaskId = ledger.listTasks()[0]?.taskId ?? null;
    try {
      const runner = new WriteDogfoodRunner({ project: scope.project, ledger, finalizer: projectFinalizer({ project: scope.project, ledger, store }), router: runtime.router, ...(deps.pin === undefined ? {} : { pin: deps.pin }), providers: snapshots, attestations: oauth, acceptances, ...(codexIsolation === undefined ? {} : { codexIsolation }), ...(grokIsolation === undefined ? {} : { grokIsolation }), ...(grokWriteIsolation === undefined ? {} : { grokWriteIsolation }), ...(deps.writeExecutor === undefined ? {} : { writer: deps.writeExecutor }), ...(deps.executor === undefined ? {} : { reviewExecutor: deps.executor }) });
      const result = await runner.run({ task, repositoryPath, baseRef, policy, classification: effective, budget, requiredContextTokens, observation: { predicted, effective, prior }, context: Object.freeze({ projectId: project.projectId, scope: "dogfood-task-worktree", access: "small-write", merge: "human-only", memory: collectTaskMemory(project, task, budget.maxContextTokens).records, session: deps.sessionTurns?.(budget.maxContextTokens) ?? [], ...(deps.goalContext === undefined ? {} : { goal: deps.goalContext }) }), review, dryRun: false, env });
      if (result.taskReceipt === null || result.taskId === null) throw new BrainGateInvariantError("DOGFOOD_WRITE_RECEIPT_MISSING", "Executed dogfood write did not produce a task receipt.");
      // Read back what the runner recorded, so the screen and the ledger cannot disagree.
      const recorded = recordedOutcomeOf(result.taskReceipt);
      const observationSequence = store.find(result.taskId)?.sequence ?? null;
      recordSpendFromReceipt(state, result.taskReceipt.usage, new ModelCatalog(state.modelCatalogPath).configured());
      recordRefusalBackoffs(state, result.taskReceipt, servedPools(result.taskReceipt.events));
      const data = Object.freeze({ plan: planData, taskId: result.taskId, observationSequence, outcome: recorded?.outcome ?? null, reviewStatus: recorded?.reviewStatus ?? null, failureKind: recorded?.failureKind ?? null, worktree: result.worktree, changedFiles: result.changedFiles, diff: result.diff, verification: result.verification, review: result.review, readyForApproval: result.readyForApproval, approvalRequired: true, mergePerformed: false, usage: result.taskReceipt.usage });
      emit(json, data, `Task ${result.taskId} · observed=${observationSequence ?? "none"} · outcome=${describeOutcome(recorded)} · branch=${result.worktree?.branch ?? "unknown"}\nChanged: ${result.changedFiles.join(", ")}\nReady for human approval: ${result.readyForApproval ? "yes" : "no"}. No merge performed.`, stdout);
      return Object.freeze({ exitCode: recorded !== null && isUsableOutcome(recorded.outcome) ? 0 : 1, data });
    } catch (error) {
      // The task exists and the runner has already recorded what became of it, so this is an
      // execution failure rather than a preflight one. Marked so the operator is never told that
      // nothing was recorded when the record exists.
      markTaskRecorded(error);
    } finally { ledger.close(); }
  } finally { store.close(); }
}

export async function runDogfoodCli(argv: readonly string[], deps: DogfoodCliDependencies = {}): Promise<DogfoodCliResult> {
  const args = [...argv];
  const json = removeFlag(args, "--json");
  const cwd = realpathSync.native(resolve(deps.cwd ?? process.cwd()));
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  let data: unknown = null;
  try {
    const command = args.shift();
    if (command === "init") {
      const flagProjectId = takeOption(args, "--project-id") ?? null;
      const flagName = takeOption(args, "--name") ?? null;
      const gitInitFlag = removeFlag(args, "--git-init");
      // The one explicit way a project's registration moves to a different checkout. Never implied:
      // without it, a manifest that names another checkout is a conflict rather than something to
      // overwrite, because overwriting would silently point a project's memory at other work.
      const rebind = removeFlag(args, "--rebind");
      noExtraArgs(args);
      // Asked first, because it decides whether the identity questions are worth asking at all.
      // A new directory is where people start, and finding out it cannot be registered only
      // after answering two prompts — with git's own error, not BrainGate's — is the ordering
      // that made this feel like a wall rather than a step.
      const ask = deps.ask ?? terminalAsk();
      let createRepository = gitInitFlag;
      if (!createRepository && repositoryReadiness(cwd).repositoryPath === null) {
        // A repository is offered, never assumed: `git init` writes to their disk. Declining is an
        // ordinary outcome rather than a dead end. A workspace does not have to be a repository, and
        // what a missing one costs is the worktree-isolated write modes — which say so themselves,
        // at the point where they are asked for something they cannot do.
        stdout([
          "",
          `  ${cwd} is not a Git repository. That is a fine workspace, and BrainGate will register it.`,
          "  A repository is what the worktree-isolated write modes need: every change they propose is",
          "  made in a task worktree, and your directory is fingerprinted before and after each run.",
          "",
        ].join("\n"));
        // With nobody to ask, no repository is created: registering the directory is the safe
        // default, and `--git-init` is the explicit way to ask for one.
        const answer = ask === undefined ? null : await ask("  Create one here with `git init`? [Y/n] ");
        createRepository = answer !== null && !/^n(o)?$/i.test(answer.trim());
        stdout("\n");
      }
      // A rebind keeps the existing project's identity and moves only what the manifest points at, so
      // it does not ask for an id and a name: asking would invite a rename where the operator asked
      // for a relocation.
      const rebindTarget = rebind ? existingManifestIdentity(cwd, manifestOption(args)) : null;
      const identity = rebindTarget ?? await resolveProjectIdentity({ cwd, projectId: flagProjectId, name: flagName, ask, stdout, quiet: deps.quiet === true });
      data = initializeDogfoodProject({ cwd, projectId: identity.projectId, name: identity.name, createRepository, rebind });
      const created = (data as { created: boolean }).created;
      const manifestPath = (data as { manifestPath: string }).manifestPath;
      const hasRepository = (data as { hasRepository: boolean }).hasRepository;
      emit(
        json,
        data,
        deps.quiet === true
          ? `${created ? "Registered" : "Using"} ${identity.projectId}.`
          : [
            `${created ? "Created" : "Using"} local BrainGate project manifest at ${manifestPath}`,
            ...(hasRepository
              ? []
              : [
                "",
                "This workspace is not a Git repository. It is registered, and sessions, goals and reading",
                "run here as they are; the worktree-isolated write modes will say what they need if asked.",
              ]),
            "",
            "Next:",
            "  braingate dogfood preflight                      check readiness, zero model calls",
            '  braingate dogfood ask plan --task "<question>"   see the routing before spending anything',
            '  braingate dogfood ask run  --task "<question>" --execute',
          ].join("\n"),
        stdout,
      );
      return Object.freeze({ exitCode: 0, data });
    }
    if (command !== "dogfood") throw new BrainGateInvariantError("CLI_COMMAND_INVALID", "M12 dispatcher supports init or dogfood.");
    const subcommand = args.shift();
    if (subcommand === undefined || subcommand === "help") {
      data = { commands: ["preflight", "ask", "write", "feedback", "report", "export"] };
      emit(json, data, "BrainGate dogfood commands: preflight, ask, write, feedback, report, export", stdout);
      return Object.freeze({ exitCode: 0, data });
    }
    if (subcommand === "preflight") return await runPreflight(args, deps, cwd, env, json, stdout);
    if (subcommand === "ask") return await runAsk(args, deps, cwd, env, json, stdout);
    if (subcommand === "write") return await runWrite(args, deps, cwd, env, json, stdout);

    const state = resolveOperatorState(env);
    const manifest = manifestOption(args);
    const { project, scope } = attachFromManifest(state, manifest, cwd);
    const store = new DogfoodStore(scope.project);
    try {
      if (subcommand === "feedback") {
        const taskId = takeOption(args, "--task-id", true)!;
        const actualComplexity = takeOption(args, "--actual-complexity", true)!;
        const actualRisk = takeOption(args, "--actual-risk");
        const outcome = takeOption(args, "--outcome", true)!;
        const regression = removeFlag(args, "--regression");
        noExtraArgs(args);
        data = store.recordFeedback({ taskId, actualComplexity, ...(actualRisk === undefined ? {} : { actualRisk }), outcome, regression });
        emit(json, data, `Recorded feedback for ${taskId}. Adaptive history now has ${store.latestFeedback().length} labeled task(s).`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      if (subcommand === "report") {
        noExtraArgs(args);
        data = store.report();
        const report = data as ReturnType<DogfoodStore["report"]>;
        emit(json, data, `Dogfood ${project.projectId}: runs=${report.runs} · feedback=${report.feedback} · regressions=${report.regressions} · underpredictions=${report.complexityUnderpredictions}\nask prior=${report.priors.ask.active ? `${report.priors.ask.complexityFloor ?? "-"}/${report.priors.ask.riskFloor ?? "-"}` : "inactive"} · write prior=${report.priors.write.active ? `${report.priors.write.complexityFloor ?? "-"}/${report.priors.write.riskFloor ?? "-"}` : "inactive"}`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      if (subcommand === "export") {
        const output = takeOption(args, "--output") ?? ".brain/dogfood-regressions.jsonl";
        noExtraArgs(args);
        const path = resolve(cwd, output);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const text = store.regressionJsonl();
        writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
        data = { projectId: project.projectId, path, records: text.length === 0 ? 0 : text.trimEnd().split("\n").length };
        emit(json, data, `Exported ${(data as { records: number }).records} sanitized regression record(s) to ${path}`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "dogfood requires preflight, ask, write, feedback, report, or export.");
    } finally { store.close(); }
  } catch (error) {
    const safe = safeError(error);
    // Whether anything was recorded for this attempt is the one thing the operator cannot infer
    // from the error itself, and it decides what they do next: fix a flag, or read a task.
    const recorded = taskWasRecorded(error);
    data = { error: safe, recorded };
    if (json) stderr(`${JSON.stringify(data, null, 2)}\n`);
    else if (recorded) stderr(`BrainGate ${safe.code}: ${safe.message}\n`);
    else stderr(`BrainGate ${safe.code}: ${safe.message}\n\nNo task was created. Nothing was recorded for this attempt.\n`);
    return Object.freeze({ exitCode: 1, data });
  }
}
