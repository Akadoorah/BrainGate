import { existsSync } from "node:fs";
import { createPromptInput } from "./prompt-input.js";
import { classifyRequestIntent } from "./request-intent.js";
import { join } from "node:path";
import { findManifest } from "./manifest-path.js";
import { runCli } from "./cli.js";
import { runDogfoodCli } from "./dogfood-cli.js";
import { runMemoryCli } from "./memory-cli.js";
import { runModelProfileCli } from "./model-profile-cli.js";
import { SLASH_COMMANDS, slashSuggestions } from "./slash-commands.js";
import { ProviderSnapshotCache } from "./provider-cache.js";
import { SessionContext, sessionThreadPath } from "./session-context.js";
import { readSessionPreferences, sessionPreferencesPath, updateSessionPreferences } from "./session-preferences.js";
import { runSetupWizard } from "./setup-wizard.js";
import {
  DEFAULT_EXECUTION_POLICY,
  EXECUTION_POLICY_IDS,
  ProjectRegistry,
  TaskLedger,
  describeExecutionPolicy,
  executionPolicyAvailability,
  executionPolicyForIntent,
  executionScopeFor,
  gitMetadataFor,
  isExecutionPolicyId,
  legacyExecutionState,
  resolveAttachment,
  type ExecutionScope,
  type ExecutionPolicyId,
} from "@braingate/core";
import {
  GoalStore,
  RUNTIME_SESSION_POLICIES,
  SESSION_ID_SOURCES,
  buildGoalContext,
  describeGoalDelta,
  sessionEnvelopeFor,
  describeSessionDecision,
  inheritedComplexityFloor,
  renderHandoff,
  type GoalRecord,
  type NativeSessionDecision,
} from "@braingate/goals";
import { describeRefusalBackoff, normalizeTaskReceipt, openQuotaStore, type TaskBriefRouteRole } from "@braingate/observability";
import { resolveOperatorState } from "@braingate/operator";
import { NodeProbeRunner, probeCliCapabilities, type ProviderId, type ProviderSnapshot } from "@braingate/providers";
import type {
  CodexIsolationAttestation,
  GrokIsolationAttestation,
  MeasuredCapabilities,
  ShadowProcessExecutor,
  TaskSnapshotProvider,
} from "@braingate/shadow";
import type { WriteProviderExecutor } from "@braingate/write";
import {
  AUTO_WORKER,
  createNativeSessionResolver,
  describeWorker,
  pinFor,
  recordSessionUse,
  resolveManualWorker,
  type RunSessionSummary,
  type WorkerSelection,
} from "./worker-commands.js";
import { COLOURED, PLAIN, renderBanner } from "./banner.js";
import { COLOURED_PROGRESS, PLAIN_PROGRESS, startProgress } from "./progress.js";

/**
 * The interactive session: `braingate` with no arguments and a terminal attached.
 *
 * It is a thin shell over the same `runCli` / `runDogfoodCli` entry points the flags drive, so
 * there is no second implementation of routing, budgets, or the write boundary to drift.
 *
 * One property is deliberately preserved rather than smoothed away. `--execute` is the only
 * thing that reaches a model, and typing a sentence must not quietly become that. So every
 * request is planned first — which costs nothing — and the plan is shown with its
 * classification, the model that would run, and any reviewer, before anything is spent. The
 * gate does not disappear here; it becomes a human confirmation instead of a flag.
 */

interface ReplDeps {
  readonly cwd: string;
  /** Where operator state lives, for locating this project's thread. Defaults to the process env. */
  readonly env?: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly ask: (question: string) => Promise<string | null>;
  /**
   * How the session reaches a provider and reads operator state.
   *
   * The session is the surface where a request becomes a provider call, so a test that wants to
   * prove what a worker was told has to stand where the model would. Injected rather than reached
   * for: the flag interface keeps its defaults, and no test has to have a subscription installed to
   * check that a follow-up continues its goal.
   */
  readonly executor?: ShadowProcessExecutor;
  readonly discoverAll?: () => Promise<readonly ProviderSnapshot[]>;
  readonly writeExecutor?: WriteProviderExecutor;
  readonly verifyCodexIsolation?: (snapshot: ProviderSnapshot) => Promise<CodexIsolationAttestation>;
  readonly verifyGrokIsolation?: (snapshot: ProviderSnapshot) => Promise<GrokIsolationAttestation>;
  readonly measureCapabilities?: () => Promise<Readonly<Record<string, MeasuredCapabilities>>>;
  readonly snapshotStore?: TaskSnapshotProvider;
  /**
   * The capability probe, for asking whether an installed build offers a session flag.
   *
   * Injected so a test can answer without spawning anything, and because the probe is the only
   * thing that may grant native session continuity: a build that no longer publishes `--session-id`
   * must be refused rather than fail at the provider with a flag error.
   */
  readonly probeCapabilities?: (providerId: string) => Promise<{ readonly features: Readonly<Record<string, { readonly supported: boolean | "unknown" }>> } | null>;
  /** False on a terminal that should not be redrawn, or when the operator asked for quiet. */
  readonly animate?: boolean;
  /** False under NO_COLOR or a dumb terminal. */
  readonly colour?: boolean;
}

/**
 * Whether free text asks for a change rather than an answer.
 *
 * The rule lives in `request-intent.ts`, where the reasoning and the adversarial cases are. This
 * function is the name the session has always used for the question.
 */
export function looksLikeWriteRequest(text: string): boolean {
  return classifyRequestIntent(text) === "write";
}

function progressStyle(deps: ReplDeps): { style: typeof PLAIN_PROGRESS; animate: boolean } {
  return { style: deps.colour === false ? PLAIN_PROGRESS : COLOURED_PROGRESS, animate: deps.animate !== false };
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

/**
 * Where this workspace's session thread belongs, or nowhere.
 *
 * A thread holds turns that name local files, so it belongs to the workspace they were produced in.
 * Without one — or if anything about resolving it fails — the session keeps its thread in memory,
 * which is what it always did.
 */
function threadOptions(scope: ExecutionScope | null): { readonly path?: string } {
  if (scope === null) return {};
  try { return { path: sessionThreadPath(scope.storageDir) }; } catch { return {}; }
}

/**
 * The tail of a finished run, once its answer has already been streamed.
 *
 * `dogfood ask run` prints the answer and then the receipt line. When the answer arrived live,
 * printing that whole block again would show it twice, so only the receipt survives.
 */
export function withoutStreamedAnswer(text: string): string {
  const marker = text.lastIndexOf("\nTask ");
  return marker < 0 ? "" : text.slice(marker);
}

/**
 * The CLI an operator knows a provider by, which is rarely the vendor's name.
 *
 * Display only, and deliberately not the binary either: nobody waiting on a run recognises `agy`
 * as the thing they signed into as Antigravity. An unknown provider keeps its own id rather than
 * being renamed into something invented.
 */
const PROVIDER_CLI_NAMES: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "claude",
  openai: "codex",
  google: "antigravity",
  xai: "grok",
  "github-copilot": "copilot",
});

export function providerCliName(providerId: string): string {
  return PROVIDER_CLI_NAMES[providerId] ?? providerId;
}

/**
 * Active refusal backoffs, in the operator's own words — for `/worker`, which has no plan to read
 * them from. Best-effort: a workspace with no global state yet, or a read that fails for any other
 * reason, answers with nothing to show rather than an error, which is the correct fact for a
 * session that has never recorded a refusal.
 */
function activeBackoffLines(env: NodeJS.ProcessEnv | undefined): readonly string[] {
  try {
    const state = resolveOperatorState(env ?? process.env);
    const quota = openQuotaStore(state.globalDir);
    try { return Object.freeze(quota.activeRefusalBackoffs().map(describeRefusalBackoff)); }
    finally { quota.close(); }
  } catch {
    return Object.freeze([]);
  }
}

/**
 * How a working role reads in the indicator: what it is doing, whose CLI is doing it, on which
 * model.
 *
 * The provider is there because that is the question a silent minute actually raises — which
 * subscription is this waiting on — and the model alone does not answer it for anyone who has not
 * memorised which family belongs to whom. The quota pool still follows when it says something the
 * provider's name does not: "antigravity · antigravity-subscription" is one fact printed twice,
 * while "codex · chatgpt-subscription" names the subscription the run is actually spending.
 */
export function activityLabel(activity: { readonly role: string; readonly model: string; readonly quotaPool: string; readonly provider?: string }): string {
  const verb = activity.role === "planner" ? "planning" : activity.role === "reviewer" ? "reviewing" : activity.role === "judge" ? "judging" : "working";
  const cli = activity.provider === undefined ? null : providerCliName(activity.provider);
  const pool = cli !== null && (activity.quotaPool.includes(cli) || activity.quotaPool.includes(activity.provider!)) ? "" : ` · ${activity.quotaPool}`;
  return `${verb}${cli === null ? "" : ` · ${cli}`} · ${activity.model}${pool}`;
}

/** The per-role capability lines the plan prints under its summary. */
export function grantLines(text: string): readonly string[] {
  return Object.freeze(
    text.split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => /^\s{2}\w+: /.test(line))
      .map((line) => line.trim()),
  );
}

/**
 * How much of a goal's own state, timeline and evidence a request may carry.
 *
 * A bounded read, not a tokenizer: the point is that the layers *together* stay small enough that
 * the task text is still the request rather than an appendix to its own history. The handoff is
 * what carries state across a provider switch; the timeline is only there so a follow-up like "and
 * the other one?" resolves.
 */
const MAX_GOAL_STATE_CHARS = 24_000;
const MAX_GOAL_EVIDENCE_REFS = 10;
const MAX_GOAL_TIMELINE_TURNS = 4;

function boundGoalState(goal: GoalRecord): GoalRecord {
  let remaining = MAX_GOAL_STATE_CHARS;
  const bounded = goal.state.acceptedFindings.map((finding) => {
    const room = Math.max(0, Math.min(600, remaining));
    remaining -= room;
    return Object.freeze({ ...finding, claim: finding.claim.slice(0, room), evidence: Object.freeze(finding.evidence.slice(0, 3)) });
  });
  return Object.freeze({ ...goal, state: Object.freeze({ ...goal.state, acceptedFindings: Object.freeze(bounded.filter((finding) => finding.claim.length > 0)) }) });
}

function safeGoalFile(): string | null {
  try {
    const state = resolveOperatorState(process.env);
    const manifest = findManifest(process.cwd());
    if (!existsSync(manifest)) return null;
    const project = new ProjectRegistry(state.home).loadFile(manifest);
    return join(project.storageDir, "goals.sqlite");
  } catch {
    return null;
  }
}

/**
 * What the installed build accepts, asked once per provider and remembered.
 *
 * A `--help` read costs nothing and happens at most once per provider per session, which is why it
 * is asked lazily: a session that never switches workers never probes anything. The reading is a
 * gate rather than a hint — `sessionIdPinning` false or unknown refuses native continuity.
 */
/** The capability feature that decides continuity for this provider, from its own policy. */
export function sessionProbeFeature(providerId: string): "sessionIdPinning" | "sessionResume" {
  return RUNTIME_SESSION_POLICIES[providerId as ProviderId]?.probeFeature ?? "sessionIdPinning";
}

/** How this provider's session id becomes known, from its own policy. */
export function sessionIdSourceFor(providerId: string): (typeof SESSION_ID_SOURCES)[number] {
  return RUNTIME_SESSION_POLICIES[providerId as ProviderId]?.idSource ?? "none";
}

class SessionCapabilityProbe {
  readonly #readings = new Map<string, boolean | "unknown">();
  readonly #pending = new Map<string, Promise<boolean | "unknown">>();
  constructor(private readonly probe: ReplDeps["probeCapabilities"], private readonly version?: (providerId: string) => string | null) {}

  /**
   * The reading, awaited.
   *
   * Asynchronous on purpose. The first version answered `unknown` while it read the help text in the
   * background, which meant the *first* turn of every session refused native continuity and only a
   * later one could use it — a session that started and finished in one turn would never resume,
   * which is the common case. Waiting one `--help` read is cheaper than being wrong about it.
   */
  async continuity(providerId: string): Promise<boolean | "unknown" | null> {
    if (this.probe === undefined) return null;
    // Which feature decides is the provider's own answer, from the policy: a runtime that names the
    // id itself is judged on `sessionResume`, not on a pinning flag it does not have.
    const feature = sessionProbeFeature(providerId);
    const key = `${providerId}:${feature}`;
    const known = this.#readings.get(key);
    if (known !== undefined) return known;
    const inFlight = this.#pending.get(key);
    if (inFlight !== undefined) return await inFlight;
    const promise = this.#read(providerId, feature);
    this.#pending.set(key, promise);
    const value = await promise;
    this.#pending.delete(key);
    return value;
  }

  async #read(providerId: string, feature: "sessionIdPinning" | "sessionResume"): Promise<boolean | "unknown"> {
    try {
      const report = await this.probe?.(providerId);
      const supported = report?.features[feature]?.supported ?? "unknown";
      this.#readings.set(`${providerId}:${feature}`, supported);
      return supported;
    } catch {
      // A probe that could not run answers `unknown`, and an unknown refuses continuity. Silence
      // must never be able to grant a capability.
      this.#readings.set(`${providerId}:${feature}`, "unknown");
      return "unknown";
    }
  }

  /** The installed build's version, as discovery read it. `null` when nothing has been discovered. */
  runtimeVersion(providerId: string): string | null {
    return this.version?.(providerId) ?? null;
  }
}

/** The plan as structure, or `null` when the surface produced something else. */
export interface ReadPlan {
  readonly summary: string;
  readonly complexity: string;
  readonly promptComplexity: string;
  readonly grantLines: readonly string[];
  /** The risk the plan used, so a prompt can say what a critical change owes before it is confirmed. */
  readonly risk: string | null;
  /**
   * The boundary the plan decided, which is not always the one the session asked for.
   *
   * A big write asked for DIRECT is planned as a worktree write with a mandatory reviewer
   * (ADR 0021). Everything the operator is shown — the line, the prompt, the session's own
   * envelope — follows the plan rather than the session's setting, because the plan is what will
   * run.
   */
  readonly executionPolicy: ExecutionPolicyId | null;
  readonly escalated: Readonly<{ from: string; reason: string }> | null;
  readonly reviewRequired: boolean;
  /** `worktree (escalated: T3) · reviewer required`, composed where the decision was made. */
  readonly policySummary: string | null;
  /** The classification and the routed roles, without the boundary, for a surface that prints it. */
  readonly roleSummary: string | null;
  /** Whether a worktree can be made here, when this plan needs one. */
  readonly worktreeReady: Readonly<{ ready: boolean; reason: string | null; changedFiles: number }> | null;
  /**
   * Who won each role and why, and who else was in the running and why they were not.
   *
   * Present on every plan, read or write: `/why` right after a plan is shown reads this rather than
   * a task the plan has not created yet (ADR 0021 Phase D).
   */
  readonly route: readonly TaskBriefRouteRole[];
  /**
   * Pools BrainGate is briefly avoiding after a refusal, in the operator's own words — never a
   * provider limit, a quota reading or a reset time (ADR 0012).
   */
  readonly backoffLines: readonly string[];
}

/** One item of `route`, read back defensively: a plan carries only what it actually computed. */
function readRouteRole(value: unknown): TaskBriefRouteRole | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.role !== "string" || typeof record.providerId !== "string" || typeof record.modelId !== "string") return null;
  const selectedReasons = Array.isArray(record.selectedReasons) ? record.selectedReasons.filter((item): item is string => typeof item === "string") : [];
  const rejected = Array.isArray(record.rejected)
    ? record.rejected.map((entry): TaskBriefRouteRole["rejected"][number] | null => {
      if (typeof entry !== "object" || entry === null) return null;
      const row = entry as Record<string, unknown>;
      if (typeof row.providerId !== "string" || typeof row.modelId !== "string") return null;
      const reasons = Array.isArray(row.reasons) ? row.reasons.filter((item): item is string => typeof item === "string") : [];
      return Object.freeze({ providerId: row.providerId, modelId: row.modelId, reasons: Object.freeze(reasons) });
    }).filter((entry): entry is TaskBriefRouteRole["rejected"][number] => entry !== null)
    : [];
  return Object.freeze({
    role: record.role,
    providerId: record.providerId,
    modelId: record.modelId,
    quotaPool: typeof record.quotaPool === "string" ? record.quotaPool : "",
    quotaState: typeof record.quotaState === "string" ? record.quotaState : "unknown",
    quotaHint: typeof record.quotaHint === "number" ? record.quotaHint : null,
    quotaObservedAt: typeof record.quotaObservedAt === "string" ? record.quotaObservedAt : null,
    rationale: Object.freeze([]),
    selectedReasons: Object.freeze(selectedReasons),
    fallbackCount: typeof record.fallbackCount === "number" ? record.fallbackCount : 0,
    rejected: Object.freeze(rejected),
  });
}

/**
 * Reads a plan back.
 *
 * Structural rather than a re-parse of the printed summary: the summary is prose, and a line that
 * said "T1/low" because no project prior happened to apply is not the same claim as "the plan is
 * T1". Returning null for anything that is not the expected shape keeps a plan that failed to build
 * from being rendered as a plan that succeeded.
 */
export function readPlan(data: unknown): ReadPlan | null {
  if (typeof data !== "object" || data === null) return null;
  const value = data as Record<string, unknown>;
  if (typeof value.summary !== "string" || typeof value.complexity !== "string" || typeof value.promptComplexity !== "string") return null;
  const grants = Array.isArray(value.grantLines) ? value.grantLines.filter((line): line is string => typeof line === "string") : [];
  // The write plan's fields, absent on a read plan and on anything older. Each is read on its own
  // terms rather than as a block, so a plan that carries some of them is not discarded for the rest:
  // the session must still be able to run against a surface that has not been taught all of this.
  const escalation = typeof value.escalated === "object" && value.escalated !== null ? value.escalated as Record<string, unknown> : null;
  const readiness = typeof value.worktreeReady === "object" && value.worktreeReady !== null ? value.worktreeReady as Record<string, unknown> : null;
  const route = Array.isArray(value.route) ? value.route.map(readRouteRole).filter((role): role is TaskBriefRouteRole => role !== null) : [];
  const backoffLines = Array.isArray(value.backoffLines) ? value.backoffLines.filter((line): line is string => typeof line === "string") : [];
  return Object.freeze({
    summary: value.summary,
    complexity: value.complexity,
    promptComplexity: value.promptComplexity,
    grantLines: Object.freeze(grants),
    risk: typeof value.risk === "string" ? value.risk : null,
    executionPolicy: typeof value.executionPolicy === "string" && isExecutionPolicyId(value.executionPolicy) ? value.executionPolicy : null,
    escalated: escalation !== null && typeof escalation.from === "string" && typeof escalation.reason === "string"
      ? Object.freeze({ from: escalation.from, reason: escalation.reason })
      : null,
    reviewRequired: value.reviewRequired === true,
    policySummary: typeof value.policySummary === "string" ? value.policySummary : null,
    roleSummary: typeof value.roleSummary === "string" ? value.roleSummary : null,
    worktreeReady: readiness !== null && typeof readiness.ready === "boolean"
      ? Object.freeze({ ready: readiness.ready, reason: typeof readiness.reason === "string" ? readiness.reason : null, changedFiles: typeof readiness.changedFiles === "number" ? readiness.changedFiles : 0 })
      : null,
    route: Object.freeze(route),
    backoffLines: Object.freeze(backoffLines),
  });
}

/** One line per role: who won, in the router's own terms, and who else was rejected and why. */
export function whyLines(route: readonly TaskBriefRouteRole[]): readonly string[] {
  const lines: string[] = [];
  for (const role of route) {
    lines.push(`  ${role.role}: ${role.providerId}/${role.modelId} — ${role.selectedReasons.length === 0 ? "no reasons recorded" : role.selectedReasons.join(", ")}`);
    for (const rejection of role.rejected) {
      lines.push(`    rejected ${rejection.providerId}/${rejection.modelId}: ${rejection.reasons.length === 0 ? "no reasons recorded" : rejection.reasons.join(", ")}`);
    }
  }
  return Object.freeze(lines);
}

/**
 * Short names for the refusals whose full text is a measurement paragraph — what BrainGate found
 * on the installed CLI, and why, in the detail a report needs — rather than a sentence a person
 * mid-conversation can act on. The full text is never lost: it stays in the error object `--json`
 * prints, and in `plan.data`/`result.data` for `/why` and anything else that reads structure.
 *
 * A code absent from this table falls back to its own message unshortened, which is what every
 * refusal did before this table existed — so a code nobody has measured as "too long" yet is never
 * silently truncated.
 */
const REFUSAL_ONE_LINERS: Readonly<Record<string, string>> = Object.freeze({
  // The Antigravity DIRECT refusal: several sentences of what was measured on the installed build
  // and the exact settings rule that would open it. A plan this fails on never reaches a route —
  // there is nothing for `/why` to show — so the detail lives in `--json` alone.
  SHADOW_PROVIDER_BLOCKED: "This worker is blocked for this role right now. Next: --json for what was measured.",
  WRITE_REVIEWER_UNAVAILABLE: "No independent reviewer is available for this write. Next: sign in to a second CLI, or score one of its models for review with /models.",
  ROUTE_NO_ELIGIBLE_MODEL: "No model is eligible for this work right now. Next: --json for the rejected reasons.",
  ROUTE_MANUAL_INELIGIBLE: "The worker you named cannot run this. Next: /auto to return to automatic selection, or --json for the reasons.",
});

/**
 * The refusal a failed plan or run carries, as one line naming the reason and the next step — or
 * `null` when `data` is not the `{ error, recorded }` shape `dogfood-cli.ts` produces, in which
 * case the caller falls back to whatever text it already captured.
 */
export function refusalLine(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = data as { readonly error?: { readonly code?: unknown; readonly message?: unknown }; readonly recorded?: unknown };
  const code = typeof value.error?.code === "string" ? value.error.code : null;
  const message = typeof value.error?.message === "string" ? value.error.message : null;
  if (code === null || message === null) return null;
  const line = REFUSAL_ONE_LINERS[code] ?? message;
  const recorded = value.recorded === true;
  return `BrainGate ${code}: ${line}${recorded ? "" : "\n\nNo task was created. Nothing was recorded for this attempt."}`;
}

/**
 * The goal layers for one request.
 *
 * Layer 1 is the durable timeline rather than the eight-hour session thread, because a goal resumed
 * tomorrow still has the exchange it continues. Layer 2 is the handoff, built from state. Layer 3
 * names the task records that hold the detail, so the worker can go and read rather than be handed
 * a copy of everything. The `context` the provider reads carries the rendered handoff beside the
 * same structure it was rendered from, so the text and the state cannot describe different things.
 */
function goalContextFor(store: GoalStore, goal: GoalRecord, input: string, budget: number, taskIds: readonly string[]): { readonly context: unknown } {
  const bounded = boundGoalState(goal);
  const turns = store.recentTurnsWithin(goal.conversationId, budget, { maxTurns: MAX_GOAL_TIMELINE_TURNS });
  const evidenceRefs = Object.freeze(taskIds.slice(-MAX_GOAL_EVIDENCE_REFS).map((taskId) => `task ${taskId} — inspect with \`braingate tasks show ${taskId}\``));
  const context = buildGoalContext({ goal: bounded, workUnit: input, recentTurns: turns, evidenceRefs });
  return Object.freeze({
    context: Object.freeze({ ...context, handoffText: renderHandoff(context.handoff) }),
  });
}

/**
 * Folds a completed turn into the goal's state.
 *
 * The finding an answer supports is not extracted by a model — a second call to summarise the first
 * one would double every task's cost and put a model's paraphrase into the state that other models
 * are then told is established. What is recorded instead is the goal's own progress: that a turn
 * finished at all, and what the next action now is. Everything the worker actually concluded stays
 * in the turn's answer, on the timeline, where the next handoff quotes it verbatim.
 *
 * A finished turn therefore makes the goal *progress*, and nothing more. It used to mark the goal
 * `diagnosed`, on the theory that "a goal with a finished turn has a result" — and real dogfood
 * showed the contradiction that produced: `Status: diagnosed` printed directly above "Nothing has
 * been established about this goal yet." A status may not claim more than the structured state
 * proves, and the structured state is `acceptedFindings`, which only `applyGoalStateUpdate` writes.
 * `diagnosed` is therefore reachable only from an accepted finding, and a goal whose turn finished
 * with nothing established stays `open`.
 *
 * What this deliberately does not do is accept a finding. Going from "a turn finished" to "this is
 * what is true" is `applyGoalStateUpdate`'s gate, and a worker cannot reach it from here: a
 * conclusion becomes established when the operator or the evidence says so, which is exactly the
 * distinction this whole layer exists to keep.
 */
function recordGoalProgress(store: GoalStore, goal: GoalRecord, input: string): void {
  // The evidence, not the prose: a diagnosis is a finding someone established, and a turn that
  // finished is not one.
  const established = goal.state.acceptedFindings.length > 0;
  store.updateGoalState(goal.goalId, {
    status: established && goal.state.status === "open" ? "diagnosed" : goal.state.status,
    openQuestions: goal.state.openQuestions,
    nextAction: input,
    assertedBy: "operator",
  });
}

/**
 * Reads an installed build's `--help` to find out what it accepts.
 *
 * A local, zero-cost, zero-model-call probe. It is the only thing that may grant native session
 * continuity, so it is deliberately the real thing rather than an assumption: a build whose help
 * could not be read answers `unknown`, and an unknown refuses continuity rather than attempting a
 * flag that may not exist.
 */
async function probeCapabilitiesFor(providerId: string): Promise<{ readonly features: Readonly<Record<string, { readonly supported: boolean | "unknown" }>> } | null> {
  try {
    const report = await probeCliCapabilities({ providerId: providerId as ProviderId, runner: new NodeProbeRunner() });
    return Object.freeze({ features: report.features });
  } catch {
    return null;
  }
}

/**
 * The provider-facing dependencies, when the caller supplied them.
 *
 * Spread into every `runDogfoodCli` call rather than looked up per call site, so a session that was
 * given a fake runtime uses it for the plan, the run and the checks alike — the plan and the run
 * describing different machines is the drift this whole file is careful about elsewhere.
 */
function runtimeDeps(deps: ReplDeps): Record<string, unknown> {
  return {
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.executor === undefined ? {} : { executor: deps.executor }),
    ...(deps.discoverAll === undefined ? {} : { discoverAll: deps.discoverAll }),
    ...(deps.writeExecutor === undefined ? {} : { writeExecutor: deps.writeExecutor }),
    ...(deps.verifyCodexIsolation === undefined ? {} : { verifyCodexIsolation: deps.verifyCodexIsolation }),
    ...(deps.verifyGrokIsolation === undefined ? {} : { verifyGrokIsolation: deps.verifyGrokIsolation }),
    ...(deps.measureCapabilities === undefined ? {} : { measureCapabilities: deps.measureCapabilities }),
    ...(deps.snapshotStore === undefined ? {} : { snapshotStore: deps.snapshotStore }),
  };
}

interface WorkerLoopState {
  selection: WorkerSelection;
  /**
   * The execution boundary for this session.
   *
   * Chosen by the operator with `/policy`, defaulting to DIRECT: the workspace itself, shared with
   * every worker and with them, which is what ordinary interactive work means. Nothing infers it
   * from the request — the classifier decides what is wanted, this decides where it may happen.
   *
   * Remembered across sessions once chosen (`session-preferences.ts`): a boundary is a decision
   * about this workspace, not about this process.
   */
  policy: ExecutionPolicyId;
  /**
   * Whether every write asks for a reviewer, not only the ones whose budget requires it.
   *
   * Off by default, because a second subscription on a one-line documentation edit is one worker
   * too many. `/review on` is for the sessions where it is not. Big and risky writes get a reviewer
   * regardless of this, which is a property of the write rather than of the session.
   */
  reviewAlways: boolean;
  /** Where this workspace's preferences are kept, or `null` when it has no storage. */
  readonly preferencesPath: string | null;
  /** Mutated by `/use --fresh`: consumed by exactly one run. */
  freshRequested: boolean;
  /** What the last run did about a native session, for `/worker`. */
  lastRun: RunSessionSummary | null;
  /**
   * The route `/why` answers from: the last plan's, until a run exists whose ledger brief carries
   * the route that actually executed. `taskId` is `null` for a plan that has not been run — `/why`
   * still answers, because the plan is where the routing decision was actually made.
   */
  lastWhy: { readonly taskId: string | null; readonly route: readonly TaskBriefRouteRole[] } | null;
  readonly probe: SessionCapabilityProbe;
  /** The installed build per provider, filled by discovery as it runs. */
  readonly versions: Map<string, string | null>;
}

/**
 * The routing layer's view of what this goal already holds.
 *
 * Two facts, from two places, because they answer different questions. `warm` is which workers hold a
 * session this request could resume — read through the same envelope rule the resolver uses, so the
 * router can never be told a session is warm that the run would then refuse. `previous` is who
 * actually produced the last turn, from the timeline's own attribution, which is what makes "continue
 * with the worker that was already here" a fact rather than an assumption.
 *
 * Absent when the goal has neither, so a first turn routes exactly as it would with no continuity
 * signal at all: this is a preference between close candidates, not a floor under them.
 */
export function routingContinuity(input: {
  readonly goals: GoalStore;
  readonly goalId: string;
  readonly conversationId: string;
  readonly intent: "read" | "write";
  readonly policy: string;
}): { readonly warm: readonly { readonly providerId: string; readonly modelId: string }[]; readonly previous?: { readonly providerId: string; readonly modelId: string } | null } | undefined {
  const warm: { providerId: string; modelId: string }[] = [];
  for (const record of input.goals.sessionsForGoal(input.goalId, (providerId) => sessionEnvelopeFor({ intent: input.intent, policy: input.policy, role: "primary", providerId }))) {
    if (record.modelId === null) continue;
    if (warm.some((item) => item.providerId === record.providerId && item.modelId === record.modelId)) continue;
    warm.push({ providerId: record.providerId, modelId: record.modelId });
  }
  let previous: { providerId: string; modelId: string } | null = null;
  // The newest turn that names a worker. A turn with no attribution is a turn whose worker is not
  // known, and reading past it to an older one would describe a handoff that did not happen.
  for (const turn of [...input.goals.recentTurns(input.conversationId, 8)].reverse()) {
    // This goal's own turns. A conversation can hold several goals, and a turn that belongs to
    // another one is not the previous worker *here* — counting it would report a handoff that never
    // happened, on the strength of a conversation the two goals happen to share.
    if (turn.goalId !== input.goalId) continue;
    const last = turn.attributedTo[turn.attributedTo.length - 1];
    if (last === undefined) continue;
    const slash = last.indexOf("/");
    if (slash <= 0 || slash === last.length - 1) continue;
    previous = { providerId: last.slice(0, slash), modelId: last.slice(slash + 1) };
    break;
  }
  if (warm.length === 0 && previous === null) return undefined;
  return Object.freeze({ warm: Object.freeze(warm), ...(previous === null ? {} : { previous }) });
}

/** Where a run under this policy happens, in the operator's words rather than the policy's id. */
function isolationPhrase(spec: { readonly isolation: string }): string {
  return spec.isolation === "none" ? "in your workspace"
    : spec.isolation === "worktree" ? "isolated worktree"
      : spec.isolation === "snapshot" ? "reading a copy"
        : "no writes";
}

async function runPlanned(input: string, deps: ReplDeps, session: SessionContext, providers: ProviderSnapshotCache, goal: GoalRecord | null, goals: GoalStore | null, ledger: TaskLedger | null, worker: WorkerLoopState): Promise<void> {
  const mode = looksLikeWriteRequest(input) ? "write" : "ask";
  const spec = executionPolicyForIntent({ policy: worker.policy, intent: mode === "write" ? "write" : "read" });
  /**
   * The boundary this request will actually run under.
   *
   * It starts as the session's own policy and is replaced by the plan's once the plan exists: a big
   * write asked for DIRECT is planned as a worktree write, and the session that resumes a native
   * session for it must ask about *that* boundary, not the one it set (ADR 0018, ADR 0021). Read
   * lazily by the resolver below, which runs during the run rather than now.
   */
  let effectivePolicy: ExecutionPolicyId = worker.policy;
  // The requested effect, in the vocabulary the session registry uses. Policy and intent are
  // separate: DIRECT with a write is a valid pair, and so is DIRECT with a read.
  const requestIntent: "read" | "write" = mode === "write" ? "write" : "read";
  const captured: string[] = [];
  const capture = (text: string): void => { captured.push(text); };
  const sessionTurns = (budget: number) => session.recent(budget);
  // One probe for the whole request. Beyond the seconds it saves, it is what makes the plan the
  // operator approved and the run that follows describe the same machine.
  // The versions discovery reads are captured here, once per request, because they decide whether a
  // native session recorded earlier is still resumable: a build that changed under a goal is a
  // mismatch to report, not a session to resume into and hope.
  const discoverAll = providers.lease({ onDiscovered: (snapshots) => { for (const snapshot of snapshots) worker.versions.set(snapshot.providerId, snapshot.version.value); } });

  // The goal layer, if this session has one. It is attached to the *plan* as well as the run: the
  // plan is what the operator approves, and a plan that routed a follow-up as a standalone T1 while
  // the run then inherited T3 would be describing a task nobody agreed to.
  const goalLayers = goal === null || goals === null ? null : goalContextFor(goals, goal, input, 24_000, ledger === null ? [] : ledger.listTasksForGoal(goal.goalId).map((task) => task.taskId));
  // The floor this request inherits from the goal it continues. `T0` is "no floor", which is both
  // the honest reading of a goal with nothing established and the value that leaves the classifier
  // exactly as it was before M20.
  const floor = goal === null ? "T0" : inheritedComplexityFloor(goal.state);
  const pin = pinFor(worker.selection);
  // The session resolver, built per run so it closes over *this* run's goal. A resolver closed over
  // a stale goal would resume a session against state that has since moved on, which is the one
  // thing a delta must not do.
  const nativeSession = goal === null || goals === null ? undefined : createNativeSessionResolver({
    goals,
    goal: () => goal,
    conversationId: () => goal.conversationId,
    freshRequested: () => worker.freshRequested,
    consumeFresh: () => { worker.freshRequested = false; },
    probedContinuity: (providerId) => worker.probe.continuity(providerId),
    runtimeVersion: (providerId) => worker.probe.runtimeVersion(providerId),
    // The workspace a session is bound to is the directory this session runs in — the same one the
    // attachment above verified, and the same one a native CLI gets as its cwd. A session recorded
    // in another workspace is not resumed on a guess (ADR 0015).
    workspace: () => deps.cwd,
    // What the run about to happen is for. Read at resolution time, because the envelope decides
    // whether a stored session may be resumed at all: a read-only session is not a write session.
    intent: () => requestIntent,
    // The boundary the *plan* settled on. An escalated write runs in a worktree, and a session
    // recorded against DIRECT is not the session that run may resume.
    policy: () => effectivePolicy,
    onResolved: (summary) => { worker.lastRun = summary; },
  });
  // Who this goal already has, which is the half of a routing decision the words cannot carry. A
  // warm worker is one that worked this goal under this exact boundary; a request that changed
  // intent or policy has no warm worker, because the session it would resume was told otherwise.
  const continuity = goal === null || goals === null ? undefined : routingContinuity({
    goals,
    goalId: goal.goalId,
    conversationId: goal.conversationId,
    intent: requestIntent,
    policy: worker.policy,
  });
  const goalDeps = {
    ...(goal === null || goalLayers === null ? {} : {
      goalContext: goalLayers.context,
      goalId: goal.goalId,
      conversationId: goal.conversationId,
      inheritedComplexity: floor,
    }),
    ...(pin === undefined ? {} : { pin }),
    ...(nativeSession === undefined ? {} : { nativeSession }),
    ...(continuity === undefined ? {} : { continuity }),
  };

  // `/review on` is the session saying that every write here gets a second reader, not only the
  // ones whose budget demands it. Sent to the plan as well as to the run, so the reviewer the
  // operator approved is the reviewer that runs.
  const reviewArgs = mode === "write" && worker.reviewAlways ? ["--review"] : [];
  // The session is where a big write is allowed to become a worktree write instead of a refusal:
  // the operator is here, the escalation is printed in the plan, and nothing runs until they say
  // yes. The flag interface deliberately does not pass this (ADR 0021).
  const escalationArgs = mode === "write" ? ["--auto-escalate"] : [];

  const planning = startProgress({ write: deps.stdout, label: "planning", ...progressStyle(deps) });
  // No `--json`: how a result is rendered is the surface's business, and this surface is a person.
  // The classification the plan *used* comes back as structure regardless, which is what the lines
  // below need — reading it back off the printed summary meant a tier was visible only when the
  // renderer happened to mention it.
  const plan = await runDogfoodCli(["dogfood", mode, "plan", "--task", input, ...reviewArgs, ...escalationArgs], {
    cwd: deps.cwd, stdout: capture, stderr: capture, sessionTurns, discoverAll, ...runtimeDeps(deps), ...goalDeps,
  });
  planning.stop();
  const planText = captured.join("");
  // A plan that could not be built exits non-zero, and its output is the diagnosis rather than
  // JSON; only a successful plan is parsed. The one-liner map keeps the terminal to a line naming
  // the reason and the next step; the full measurement text — what `refusalLine` fell back from —
  // stays in `plan.data` and reaches `--json` unshortened (ADR 0021 Phase D).
  if (plan.exitCode !== 0) { deps.stderr(`${refusalLine(plan.data) ?? planText}\n`); return; }
  const planJson = readPlan(plan.data);
  const planSummary = planJson === null ? "the plan produced no readable output" : planJson.roleSummary ?? planJson.summary;
  // `/why` right after this plan is shown, before anything has run: the routing decision was
  // already made, and a plan the operator declines still answers what it would have done.
  worker.lastWhy = { taskId: null, route: planJson?.route ?? [] };
  // The boundary the plan settled on, which the session now follows: a big write asked for DIRECT
  // has been planned as a worktree write with a mandatory reviewer, and everything below — the
  // line, the refusal, the prompt, the run and the session envelope — has to be about that.
  if (planJson?.executionPolicy !== null && planJson?.executionPolicy !== undefined) effectivePolicy = planJson.executionPolicy;
  const planSpec = effectivePolicy === worker.policy ? spec : executionPolicyForIntent({ policy: effectivePolicy, intent: requestIntent });

  // What the run will be, in the policy's own words. "write · isolated worktree" was the only
  // answer this line had, and it was wrong for every DIRECT run — which is now the ordinary one.
  deps.stdout(`\n  ${mode === "write" ? "write" : "read-only"} · ${planJson?.policySummary ?? planSpec.label} · ${isolationPhrase(planSpec)} · ${planSummary}\n`);
  // Any pool BrainGate is briefly avoiding after a refusal, said here rather than discovered only
  // when a role routed around it: it is BrainGate's own backoff, never a provider limit (ADR 0012).
  for (const line of planJson?.backoffLines ?? []) deps.stdout(`  ${line}\n`);
  // The goal the request continues, said before anything is spent. This is the line that was
  // missing when a follow-up was silently treated as a brand-new task.
  if (goal !== null) {
    const raised = planJson !== null && planJson.promptComplexity !== planJson.complexity;
    deps.stdout(`  continues goal ${goal.goalId.slice(0, 8)} · ${goal.state.status}${goal.state.acceptedFindings.length === 0 ? "" : ` · ${String(goal.state.acceptedFindings.length)} established finding(s)`}${raised ? ` · raised to ${planJson.complexity} by this goal (the words alone were ${planJson.promptComplexity})` : ""}\n`);
  }
  // What each role may do, and what it asked for and did not get. This is the half of the plan
  // that used to be dropped, and it is the half that answers "why is this reading less than I
  // expected" before the run rather than after it.
  for (const line of planJson?.grantLines ?? []) deps.stdout(`  ${line}\n`);
  /**
   * A worktree write with nowhere to put the worktree: said once, and nothing is spent.
   *
   * This is the shape a big write takes in an ordinary working directory — the operator has
   * uncommitted work, which is the normal state of someone mid-task, and the change they just asked
   * for is one that may not touch that work. It used to become a confirmation prompt followed by a
   * guard failure after they said yes. One message, with the reason and the remedy, and no question
   * at all: there is nothing to confirm when the answer cannot be carried out.
   *
   * BrainGate does not stash. Moving someone's uncommitted work is not a step a tool takes on their
   * behalf, and saying so is part of the message rather than a footnote.
   */
  if (mode === "write" && planJson?.worktreeReady != null && !planJson.worktreeReady.ready) {
    const why = planJson.escalated?.reason ?? `${planJson.complexity}/${planJson.risk ?? "unknown"}`;
    deps.stdout([
      `  This is a ${why} change, so it runs in an isolated worktree with a reviewer from another provider — never in your checkout.`,
      `  It cannot start yet: ${planJson.worktreeReady.reason ?? "a worktree cannot be created from this repository"}.`,
      "  Commit or stash your work, then ask again. Nothing was spent, and BrainGate never stashes for you.",
      "",
      "",
    ].join("\n"));
    return;
  }
  // The prompt says what the run will do to the operator's own files, which for an escalated write
  // is "nothing": the change lands in a task worktree and the merge is theirs. A critical change
  // owes human approval before that merge, and the prompt is where that belongs (ADR 0005).
  const answer = await deps.ask(mode === "write" && planSpec.isolation === "worktree"
    ? `  Run it? This changes a task worktree, never your checkout; merging is yours.${planJson?.risk === "critical" ? " Human approval is required before any merge." : ""} [y/N] `
    : mode === "write" && planSpec.allowWrites
      ? "  Run it? This changes files in your workspace, and nothing is committed. [y/N] "
      : "  Run it? [y/N] ");
  if (answer === null || !/^y(es)?$/i.test(answer.trim())) { deps.stdout("  Skipped. Nothing was spent.\n\n"); return; }

  deps.stdout("\n");
  const spoken: string[] = [];
  // The indicator has to be gone before the first byte of real output, or the two share a line.
  const working = startProgress({ write: deps.stdout, label: mode === "write" ? "writing" : "working", ...progressStyle(deps) });
  // The answer is streamed straight to the terminal as the model produces it, and the final print
  // would then repeat every word of it. This tracks whether that happened.
  let streamed = false;
  // `provider/model`, in the order the run used them. Recorded on the turn so the timeline can say
  // who answered, which is what makes a later "switch back to Sonnet" a thing the record supports.
  let attributed: readonly string[] = Object.freeze([]);
  // Buffered rather than forwarded live: the only thing `dogfood <mode> run` ever writes to
  // `stderr` is its own final failure text, and that text is exactly what the one-liner map
  // shortens. Kept as the fallback for a code the map does not know, or a shape `result.data`
  // does not carry — so nothing this run says is ever lost, only shortened when it is understood.
  let bufferedStderr = "";
  // The run's record — task id, outcome, usage, the answer — comes back as data without asking for
  // JSON, and the human-readable answer is what the operator sees.
  // The session's policy, not the plan's: the run re-derives the escalation from the same
  // classification under `--auto-escalate`, so the task's own record carries the move it made
  // rather than arriving at a worktree with no memory of having been asked for a workspace.
  const result = await runDogfoodCli(["dogfood", mode, "run", "--task", input, "--policy", worker.policy, ...reviewArgs, ...escalationArgs, "--execute"], {
    cwd: deps.cwd,
    stdout: (text) => {
      working.stop();
      spoken.push(text);
      // The answer is already on screen; what is left to print is the receipt after it. The record
      // itself travels in `result.data`, so this decides display and nothing else.
      deps.stdout(streamed ? withoutStreamedAnswer(text) : text);
    },
    stderr: (text) => { working.stop(); bufferedStderr += text; },
    // Who is working, while they work. A task spends several roles across several
    // subscriptions, and the indicator is the only place that is visible as it happens.
    onRoleActivity: (activity) => { if (activity.stage === "started") working.label(activityLabel(activity)); },
    onThinking: () => { working.label("thinking"); },
    onText: (text) => {
      // The first byte of an answer is the moment the wait ends. The indicator goes, and
      // everything after this is the model writing.
      if (!streamed) { working.stop(); streamed = true; }
      deps.stdout(text);
    },
    sessionTurns,
    discoverAll,
    onTurnAttribution: (value) => { attributed = value; },
    ...runtimeDeps(deps),
    ...goalDeps,
  });
  if (streamed) deps.stdout("\n");
  working.stop();
  // The refusal, in one line naming the reason and the next step; the full measurement text is
  // still in `result.data` and reaches `--json` unshortened (ADR 0021 Phase D).
  if (result.exitCode !== 0) {
    const line = refusalLine(result.data);
    deps.stderr(line === null ? bufferedStderr : `${line}\n`);
  }
  // The route this run actually used, read back from the ledger's own brief rather than kept from
  // the plan: a run can differ from what it was planned against (a pool that refused between the
  // two, for one), and the ledger is the record of what happened rather than what was proposed.
  if (result.exitCode === 0) {
    const taskId = taskIdOf(result.data);
    if (taskId !== null && ledger !== null) {
      try {
        const brief = normalizeTaskReceipt(ledger.receipt(taskId)).brief;
        if (brief !== null) worker.lastWhy = { taskId, route: brief.route };
      } catch { /* the plan's own route is still a true answer to "why" */ }
    }
  }
  // Only a clean result joins the thread. A failed or rejected task would otherwise become the
  // premise of the next follow-up.
  if (result.exitCode === 0) session.record(input, spoken.join("").replace(/\n*Task [0-9a-f-]{36}.*$/s, "").trim());
  // The decision was made before the run; whether the runtime honoured it is known only now, and
  // the receipt line and `/worker` both read it from the same place so they cannot tell two stories.
  if (result.exitCode === 0 && worker.lastRun !== null && (result.data as { readonly sessionRecovered?: boolean } | null)?.sessionRecovered === true) {
    worker.lastRun = Object.freeze({ ...worker.lastRun, recovered: true });
  }
  // The goal's own record of the turn, on the same terms: a clean result, and nothing at all when
  // the run failed. What this buys is that the *next* turn — tomorrow, on another provider, after
  // this process is gone — is a continuation rather than a new question.
  if (result.exitCode === 0 && goal !== null && worker.lastRun?.session != null) {
    const decision = worker.lastRun.session;
    if (worker.lastRun.recovered === true) {
      // The decision to resume was right when it was made; the runtime did not have that session.
      // Saying so is the difference between the terminal and the ledger agreeing and not.
      deps.stdout("  session: that session was not found by the runtime — a fresh native session carried the goal handoff.\n");
    } else if (decision.kind !== "disabled") {
      deps.stdout(`  session: ${describeSessionDecision(decision)}${worker.lastRun.delta === null ? "" : ` · delta: ${describeGoalDelta(worker.lastRun.delta)}`}\n`);
    }
  }
  if (goal !== null && goals !== null) {
    const taskId = taskIdOf(result.data);
    // The answer of record, preferred over anything re-assembled from the terminal. A provider that
    // streams gives the session the prose as it is written, and one that does not gives it only in
    // the record; the record is the one source complete either way, so the timeline is written from
    // it and the streamed text is the fallback.
    const answer = (answerOf(result.data) ?? spoken.join(" ")).replace(/\n*Task [0-9a-f-]{36}.*$/s, "").trim();
    if (result.exitCode === 0 && taskId !== null && ledger !== null) {
      // The write path creates its task inside the runner, so the link is made here rather than at
      // creation. Idempotent, and a no-op for the read path, which already carries the goal.
      try { ledger.linkTaskToGoal(taskId, goal.goalId, goal.conversationId); }
      catch { /* an already-linked task is the expected case, not a failure */ }
    }
    if (result.exitCode === 0 && answer.length > 0) {
      const turn = goals.recordTurn({
        conversationId: goal.conversationId,
        goalId: goal.goalId,
        taskId,
        request: input,
        answer,
        attributedTo: attributed,
      });
      // Where the session's next delta starts from. Written after the turn so it covers everything
      // up to and including this one, and against the state the turn produced rather than the state
      // it started in — a snapshot taken before would report this turn's own work as news.
      recordSessionUse({ goals, summary: worker.lastRun, goal, taskId, turnSequence: turn.sequence });
      // The goal as the store has it *now*, not as it was when this turn started. The record read
      // before the run is a snapshot from before the run, and folding progress into a snapshot is
      // how a goal stays `open` after it has been answered.
      recordGoalProgress(goals, goals.getGoal(goal.goalId) ?? goal, input);
    }
  }
  // The exit code is reported, not interpreted. Inventing "completed but needs your review" here
  // was a guess about a task this layer never looked at: a non-zero exit can mean a blocked review,
  // a provider refusal, or a run that recorded nothing at all, and those need different responses.
  // Named as something to run *in a shell*, and paired with the command that does the same job here.
  // The bare `tasks list` this used to suggest was read by the session as a new request, so following
  // BrainGate's own advice spent a task on it — the guidance was the bug, not the operator.
  if (result.exitCode !== 0) deps.stdout("\n  Exit 1: this task did not finish successfully. Use /status here to see what was recorded, or run `braingate tasks list` in your shell.\n\n");
}

/** The task id a finished run reported, or `null` when the run recorded nothing usable. */
export function taskIdOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { readonly taskId?: unknown }).taskId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** What the worker answered, read from the run's record rather than from the terminal. */
export function answerOf(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { readonly answer?: unknown }).answer;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function runSlash(line: string, deps: ReplDeps, session: SessionContext, goals: GoalStore | null, ledger: TaskLedger | null, worker: WorkerLoopState, workspaceScope: ExecutionScope | null): Promise<"continue" | "exit"> {
  const [command, ...rest] = line.slice(1).trim().split(/\s+/);
  // The session's own environment, not the process's: `/remember` under a BRAINGATE_HOME the session
  // was given wrote its proposal into the default home, where `memory promote` in that session
  // could not find it — found by a real memory check whose proposal "did not exist".
  const io = { cwd: deps.cwd, ...(deps.env === undefined ? {} : { env: deps.env }), stdout: deps.stdout, stderr: deps.stderr };

  switch (command) {
    case "exit": case "quit": case "q":
      return "exit";
    case "help": case "?":
      deps.stdout([
        "",
        "  Type a request in plain words. A question is answered; an instruction to change",
        "  something is planned as a write in this workspace — or, when it is a big change",
        "  (T3/T4, or high/critical risk), in an isolated worktree with a reviewer from another",
        "  provider, which you merge. Either way you see the plan and confirm before anything",
        "  is spent.",
        "",
        "  Follow-ups continue the same goal. Every worker — whichever provider it is routed to —",
        "  is given the goal's established findings, what has changed and what is unresolved, so",
        "  switching models continues the work instead of restarting it.",
        "",
        "  Which worker does the work. A switch keeps the goal: the next worker is handed the",
        "  established findings, and a worker whose own session can be resumed is given only what",
        "  changed while it was away.",
        "",
        "  Type / to see these as you type; Tab completes.",
        "",
        ...SLASH_COMMANDS.map((command) => `  ${(`/${command.name}${command.args === undefined ? "" : ` ${command.args}`}`).padEnd(44)} ${command.hint}`),
        "",
      ].join("\n"));
      return "continue";
    case "remember": {
      const text = rest.join(" ").trim();
      if (text.length === 0) {
        deps.stderr("  Usage: /remember <what this project needs known>\n");
        return "continue";
      }
      // The session thread ends with this process; this does not. It is recorded as a proposal
      // rather than as fact, because what was typed is a claim about the project and the
      // evidence gate is what tells the two apart.
      await runMemoryCli(["memory", "note", "--text", text], io);
      return "continue";
    }
    case "memory":
      await runMemoryCli(["memory", "list"], io);
      await runMemoryCli(["memory", "proposals"], io);
      return "continue";
    case "forget":
      session.clear();
      deps.stdout("  Session thread cleared, here and on disk. Project memory is untouched.\n");
      return "continue";
    case "goal": {
      if (goals === null) { deps.stderr("  No goal store here. Goals need a registered project and a readable operator state.\n"); return "continue"; }
      const goal = goals.activeGoal();
      // A goal belongs to the workspace whose files it reasons about, so the workspace is part of
      // what this report has to say — and a goal found here that belongs to another one is named
      // rather than hidden, because otherwise it looks like the goal simply vanished.
      const foreign = goals.goalsFromAnotherWorkspace();
      if (goal === null) {
        deps.stdout(foreign.length === 0
          ? "  No goal yet. The next request starts one.\n"
          : `  No goal in this workspace. ${String(foreign.length)} goal(s) here belong to another workspace and are not used.\n`);
        return "continue";
      }
      if (workspaceScope !== null) deps.stdout(`  Workspace: ${workspaceScope.workspacePath} · ${workspaceScope.workspaceId}\n`);
      deps.stdout("\n");
      deps.stdout(`${renderHandoff(buildGoalContext({ goal, workUnit: "(nothing yet — this is the current state)", recentTurns: [] }).handoff).split("\nYour current task:")[0]!}\n`);
      // What has actually been run under this goal, read from the ledger rather than from the goal's
      // own copy. Two stores, one question, and the ledger is the one that holds the task records.
      const tasks = ledger === null ? [] : ledger.listTasksForGoal(goal.goalId);
      if (tasks.length > 0) deps.stdout(`\nTasks under this goal: ${tasks.length} · newest ${tasks[tasks.length - 1]!.taskId}\n`);
      return "continue";
    }
    case "use": {
      // Only the first token is the target: `/use anthropic/claude-sonnet --fresh` must pass the
      // flag as a flag rather than folding it into the model id, where it would be reported as a
      // model nobody configured.
      const result = resolveManualWorker({ target: rest[0] ?? "", ...(deps.env === undefined ? {} : { env: deps.env }) });
      if (!result.ok) { deps.stderr(`  ${result.message}\n`); return "continue"; }
      worker.selection = result.selection;
      // `--fresh` is consumed by the next run, so it is armed here and cleared when that run
      // resolves its session. Arming it permanently would make every later turn a new session,
      // which is not what "start fresh" means.
      worker.freshRequested = result.selection.mode === "manual" && (result.selection.fresh || rest.slice(1).includes("--fresh"));
      if (worker.selection.mode === "manual") {
        // Read the build's capability now, so the first run after the switch has a real answer
        // rather than an in-flight one. A failure here is harmless: unknown refuses continuity.
        const continuity = await worker.probe.continuity(worker.selection.providerId);
        const source = SESSION_ID_SOURCES.includes(sessionIdSourceFor(worker.selection.providerId)) ? sessionIdSourceFor(worker.selection.providerId) : "none";
        if (continuity === true && source === "pinned") deps.stdout("  Native session continuity: supported by the installed build; BrainGate names the session and resumes it.\n");
        else if (continuity === true && source === "reported") deps.stdout("  Native session continuity: this build reports the session it creates, and BrainGate resumes it on the next compatible turn.\n");
        else if (continuity === false) deps.stdout("  Native session continuity: this build publishes no session to continue, so each turn is a fresh invocation with a goal handoff.\n");
        else deps.stdout("  Native session continuity: not confirmed for this build, so each turn will be a fresh invocation with a goal handoff.\n");
      }
      deps.stdout(`  ${result.message}\n`);
      return "continue";
    }
    case "auto": {
      worker.selection = AUTO_WORKER;
      worker.freshRequested = false;
      deps.stdout("  Automatic selection restored. BrainGate routes each turn again — availability, quota, capability and isolation decide.\n");
      return "continue";
    }
    case "project": {
      // What this session is bound to, and the one explicit way to change it. Printed from the same
      // resolution `runRepl` already performed, so the answer cannot differ from what is executing.
      const attached = resolveAttachment({
        cwd: deps.cwd,
        registry: { loadFile: (manifestPath) => new ProjectRegistry(resolveOperatorState(deps.env ?? process.env).home).loadFile(manifestPath) },
      });
      deps.stdout("\n");
      if (attached.kind === "attached") {
        // The workspace id is the key every piece of execution state is filed under, so it is worth
        // showing: an operator who wants to know which ledger, goal store and sessions this session
        // is using has one line to read rather than a directory to guess at.
        // The registered workspace, not the directory they happen to be in: state is filed under the
        // former, and `Directory` below reports the latter when they differ.
        const scope = executionScopeFor(attached.project, attached.registeredRoot);
        const git = gitMetadataFor(scope.workspacePath) ?? scope.git;
        deps.stdout(`  Project:      ${attached.project.projectId} (${attached.project.name})\n`);
        deps.stdout(`  Workspace:    ${scope.workspacePath}\n`);
        deps.stdout(`  Workspace ID: ${scope.workspaceId}\n`);
        // Where workers actually run, when that is below the workspace: the state is filed under the
        // workspace and the native CLI still starts in the directory the operator launched from.
        if (attached.checkout.root !== scope.workspacePath) deps.stdout(`  Directory:    ${attached.checkout.root}\n`);
        deps.stdout(`  State:        ${scope.storageDir}\n`);
        deps.stdout(`  Manifest:     ${attached.checkout.manifestPath ?? "none"}\n`);
        // Reported because it is useful evidence, and labelled because it is not the identity: the
        // directory above is where the native CLIs run whether or not there is a repository above it.
        deps.stdout(git === null
          ? "  Git:          none — this workspace is not inside a repository\n"
          : `  Git:          ${git.gitRoot} · ${git.branch ?? "(detached)"}${git.head === null ? " · no commits yet" : ` @ ${git.head.slice(0, 8)}`}${git.dirty ? " · uncommitted changes" : " · clean"}\n`);
        deps.stdout("  Execution is bound to this workspace: the ledger, goals, sessions and evidence above.\n");
        deps.stdout("  A different directory is a different workspace, even when it shares a name, a remote or a\n  repository, and it does not inherit any unfinished work from this one.\n\n");
        return "continue";
      }
      if (attached.kind === "unregistered") {
        deps.stdout(`  No project is registered for ${attached.checkout.root}.\n  Run \`braingate init\` here to create one.\n\n`);
        return "continue";
      }
      if (attached.kind === "inspecting") {
        // Unreachable from a session, which never names a manifest explicitly — the manifest is the
        // one found by walking up from here. A total switch still says what it found.
        deps.stdout(`  Project:   ${attached.project.projectId} (${attached.project.name})\n  Workspace: ${attached.registeredRoot}\n  This session is not attached to it.\n\n`);
        return "continue";
      }
      deps.stderr(`${attached.message}\n\n`);
      return "continue";
    }
    case "worker": {
      const goal = goals === null ? null : goals.activeGoal();
      const known = goals === null ? [] : goals.listProviderSessions(8);
      for (const line of describeWorker({ selection: worker.selection, goal, lastRun: worker.lastRun, knownSessions: known })) deps.stdout(`${line}\n`);
      // Native continuity is per workspace as well as per provider and model, so which workspace
      // these sessions belong to is part of the answer to "what would resume". The policy is the
      // other half: it is the boundary the next run happens inside.
      if (workspaceScope !== null) deps.stdout(`  workspace: ${workspaceScope.workspacePath} · ${workspaceScope.workspaceId}\n`);
      deps.stdout(`  policy:    ${describeExecutionPolicy(worker.policy)}\n`);
      // Pools BrainGate is briefly avoiding after a refusal, in its own words — never a provider
      // limit, a quota reading or a reset time (ADR 0012).
      for (const line of activeBackoffLines(deps.env)) deps.stdout(`  ${line}\n`);
      return "continue";
    }
    case "why": {
      const prefix = rest[0];
      if (prefix !== undefined) {
        if (ledger === null) { deps.stderr("  No task ledger here.\n"); return "continue"; }
        const match = ledger.listTasks().find((task) => task.taskId.startsWith(prefix));
        if (match === undefined) { deps.stderr(`  No task starting with \`${prefix}\` in this workspace.\n`); return "continue"; }
        let route: readonly TaskBriefRouteRole[] = [];
        try { route = normalizeTaskReceipt(ledger.receipt(match.taskId)).brief?.route ?? []; }
        catch { /* an unreadable receipt reports nothing recorded, below */ }
        if (route.length === 0) { deps.stderr(`  Task ${match.taskId} has no recorded route.\n`); return "continue"; }
        deps.stdout(`  Route for task ${match.taskId}:\n`);
        for (const line of whyLines(route)) deps.stdout(`${line}\n`);
        return "continue";
      }
      if (worker.lastWhy === null || worker.lastWhy.route.length === 0) {
        deps.stderr("  Nothing planned yet in this session. Ask something first.\n");
        return "continue";
      }
      deps.stdout(worker.lastWhy.taskId === null
        ? "  Route for the last plan (not yet run):\n"
        : `  Route for task ${worker.lastWhy.taskId}:\n`);
      for (const line of whyLines(worker.lastWhy.route)) deps.stdout(`${line}\n`);
      return "continue";
    }
    case "policy": {
      const requested = rest[0];
      if (requested === undefined) {
        deps.stdout(`  Execution policy: ${describeExecutionPolicy(worker.policy)}\n`);
        deps.stdout("  Choose with /policy direct | read-only | worktree | snapshot | unattended.\n");
        return "continue";
      }
      if (!isExecutionPolicyId(requested)) {
        deps.stderr(`  Unknown policy \`${requested}\`. Known: ${EXECUTION_POLICY_IDS.join(", ")}.\n`);
        return "continue";
      }
      const availability = executionPolicyAvailability({ policy: requested, hasRepository: workspaceScope?.git !== null && workspaceScope !== null });
      if (!availability.available) { deps.stderr(`  ${availability.reason ?? "That policy is not available here."}\n`); return "continue"; }
      worker.policy = requested;
      // Kept for the next session in this workspace. A boundary the operator chose once and had to
      // re-choose every morning is a boundary they stop choosing.
      if (worker.preferencesPath !== null) updateSessionPreferences(worker.preferencesPath, { policy: requested });
      // Changing the boundary spends nothing and reaches no provider: it is a local decision about
      // where the next run happens, which is why it can be made mid-conversation.
      deps.stdout(`  Execution policy: ${describeExecutionPolicy(requested)}\n`);
      if (requested === "worktree") deps.stdout("  A write under this policy is proposed in an isolated worktree and merged by you.\n");
      if (requested === "snapshot") deps.stdout("  A read under this policy runs against a copy, so it cannot touch the workspace.\n");
      if (requested === "read-only") deps.stdout("  Writes are refused while this is selected.\n");
      return "continue";
    }
    case "new": {
      if (goals === null) { deps.stderr("  No goal store here.\n"); return "continue"; }
      const conversation = goals.openConversation();
      const current = goals.activeGoal(conversation.conversationId);
      // Closing the old goal is the point: a finished goal is not inherited, so "start something
      // else" must be a decision rather than a side effect of phrasing the request differently.
      if (current !== null) goals.setGoalStatus(current.goalId, "abandoned");
      deps.stdout("  Previous goal set aside. The next request starts a new one.\n");
      return "continue";
    }
    case "review": {
      const requested = rest[0]?.toLowerCase();
      if (requested === undefined) {
        deps.stdout(worker.reviewAlways
          ? "  Reviewer on every write: on. Big or risky writes get one regardless.\n  /review off leaves it to the task's own budget.\n"
          : "  Reviewer on every write: off — each write follows its own budget, and a big or risky\n  one still gets a reviewer. /review on asks for one every time.\n");
        return "continue";
      }
      if (requested !== "on" && requested !== "off") {
        deps.stderr("  Usage: /review [on|off]\n");
        return "continue";
      }
      worker.reviewAlways = requested === "on";
      if (worker.preferencesPath !== null) updateSessionPreferences(worker.preferencesPath, { reviewAlways: worker.reviewAlways });
      deps.stdout(worker.reviewAlways
        ? "  Reviewer on every write: on. A second worker — from another provider where one is\n  configured — reads every change before it is reported.\n"
        : "  Reviewer on every write: off. Each write follows its own budget.\n");
      return "continue";
    }
    case "setup": {
      // The wizard again, on a workspace that is already registered: nothing about the project is
      // changed, newly listed models are offered, and anything the operator has scored is kept.
      const wizard = await runSetupWizard({
        cwd: deps.cwd,
        stdout: deps.stdout,
        stderr: deps.stderr,
        ask: deps.ask,
        ...(deps.env === undefined ? {} : { env: deps.env }),
        ...(deps.discoverAll === undefined ? {} : { discoverAll: deps.discoverAll }),
      });
      worker.reviewAlways = wizard.reviewAlways;
      return "continue";
    }
    case "status":
      await runCli(["status", "--project", ".brain/project.json"], io);
      return "continue";
    case "models":
      // Through the profile surface, not the catalogue one: `runCli` has never understood
      // `models profile` — the top-level dispatcher routes it to `runModelProfileCli` — so `/models`
      // answered `CLI_SUBCOMMAND_INVALID` for every session that ever typed it. Found by the first
      // real first-run, which is where this kind of thing is always found.
      await runModelProfileCli(["models", "profile"], io);
      return "continue";
    case "providers":
      // Two halves of one question. Discovery says what is installed and how it is signed in;
      // the role listing says what BrainGate will actually let each one do on this machine,
      // and why the closed ones are closed. Either alone leaves the operator guessing.
      await runCli(["discover"], io);
      deps.stdout("\n");
      await runCli(["providers", "list"], io);
      return "continue";
    case "doctor":
      await runCli(["doctor", "--project", ".brain/project.json"], io);
      return "continue";
    case "feedback": {
      const [taskId, complexity, outcome] = rest;
      if (taskId === undefined || complexity === undefined || outcome === undefined) {
        deps.stderr("  Usage: /feedback <task-id> <T0-T4> <success|partial|failure>\n");
        return "continue";
      }
      await runDogfoodCli(["dogfood", "feedback", "--task-id", taskId, "--actual-complexity", complexity, "--outcome", outcome], io);
      return "continue";
    }
    default:
      deps.stderr(`  Unknown command /${String(command)}. Try /help.\n`);
      return "continue";
  }
}

/**
 * Runs the session. Returns the process exit code.
 *
 * Callers are responsible for deciding that a terminal exists; without one the flag interface
 * is the only sensible surface and `braingate` prints its command listing instead.
 */
export async function runRepl(deps: ReplDeps): Promise<number> {
  await renderBanner({
    write: deps.stdout,
    // Colour is opt-out; NO_COLOR is the convention and it is honoured rather than reinvented.
    style: deps.colour === false ? PLAIN : COLOURED,
    // Redrawing in place needs a terminal that will move the cursor. Anywhere else, and when
    // asked to keep quiet, the finished picture is printed once.
    still: deps.animate === false,
  });

  /**
   * Which workspace this session may execute against, decided before anything else happens.
   *
   * The manifest is found by walking upward from here, and the workspace it names is then compared
   * with the directory the operator is actually standing in. Where the two disagree the session
   * stops — before a plan, before a thread, before a goal — because every one of those would
   * otherwise be filed under a workspace the operator is not looking at. Real dogfood produced
   * exactly that: a session in one clone reasoning about another.
   *
   * The directory they are in *is* the workspace, even when a manifest further up names a parent of
   * it: the provider's cwd is where they launched, which is what makes a native CLI behave the way
   * it does when they run it themselves.
   *
   * A refusal here is not about permissions. Both directories are the operator's; they are simply
   * not the same working state, and only the operator can say which one the project should follow.
   */
  const attachment = resolveAttachment({
    cwd: deps.cwd,
    registry: { loadFile: (manifestPath) => new ProjectRegistry(resolveOperatorState(deps.env ?? process.env).home).loadFile(manifestPath) },
  });
  if (attachment.kind === "refused") {
    deps.stderr(`\n${attachment.message}\n\n`);
    return 1;
  }

  // Arriving in an unregistered directory is the ordinary first run, not an error to be turned
  // away at. The banner has already said what this is; the wizard now does the whole of setting
  // up — register, adopt models with starting scores, record what needs accepting — in at most
  // four questions, and says what it assumed for everything else.
  let wizardReviewAlways: boolean | null = null;
  if (attachment.kind === "unregistered") {
    const wizard = await runSetupWizard({
      cwd: deps.cwd,
      stdout: deps.stdout,
      stderr: deps.stderr,
      ask: deps.ask,
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.discoverAll === undefined ? {} : { discoverAll: deps.discoverAll }),
    });
    if (!wizard.registered) return wizard.exitCode === 0 ? 1 : wizard.exitCode;
    wizardReviewAlways = wizard.reviewAlways;
  }

  /**
   * The workspace this session executes in, resolved once.
   *
   * Resolved *after* the first-run branch, because `init` writes the manifest the attachment above
   * could not find. Everything the session files — the thread, the conversation, the goal, the
   * ledger, the sessions — goes under this workspace's storage, and the provider's cwd is this
   * directory. Two workspaces of one project therefore share durable memory and nothing else.
   *
   * `null` when even the second attempt cannot attach, which leaves the session running in memory
   * rather than refusing to start.
   */
  const resolved = attachment.kind === "unregistered"
    ? resolveAttachment({
      cwd: deps.cwd,
      registry: { loadFile: (manifestPath) => new ProjectRegistry(resolveOperatorState(deps.env ?? process.env).home).loadFile(manifestPath) },
    })
    : attachment;
  const workspaceScope: ExecutionScope | null = resolved.kind === "attached" || resolved.kind === "inspecting"
    ? executionScopeFor(resolved.project, resolved.kind === "inspecting" ? resolved.registeredRoot : resolved.checkout.root)
    : null;

  // State written before a workspace was part of the identity cannot be assigned to one: it is the
  // history of a project id, and two directories shared it. It is preserved where it is, never read
  // here, and never injected into this workspace's goals — so the operator is told once, at the top,
  // rather than left wondering where their earlier tasks went.
  if (workspaceScope !== null) {
    const legacy = legacyExecutionState(workspaceScope.projectStorageDir);
    if (legacy.length > 0) {
      deps.stdout([
        "  Execution state from before workspaces were part of the identity is present at:",
        `    ${workspaceScope.projectStorageDir}`,
        `    ${legacy.join(", ")}`,
        "  It is preserved and not used: it cannot say which directory it came from. This workspace",
        "  starts empty, and nothing from the above is carried into it.",
        "",
      ].join("\n"));
    }
  }

  // The wizard has just printed this exact line, so a session that ran it says the second half
  // only. Printing readiness twice, two lines apart, reads as two different readings.
  if (wizardReviewAlways === null) {
    const header: string[] = [];
    await runDogfoodCli(["dogfood", "preflight"], { cwd: deps.cwd, stdout: (t) => header.push(t), stderr: (t) => header.push(t), ...runtimeDeps(deps) });
    deps.stdout(`  ${firstLine(header.join(""))}\n`);
  }
  /**
   * What this workspace decided last time.
   *
   * Read here rather than at the loop, so the session says what boundary it is running under
   * before the first prompt rather than after it. `/policy worktree` and `/review on` are
   * workspace-scoped execution state (ADR 0016), kept beside the thread.
   */
  const preferencesPath = workspaceScope === null ? null : sessionPreferencesPath(workspaceScope.storageDir);
  const preferences = preferencesPath === null ? {} : readSessionPreferences(preferencesPath);
  const reviewAlways = wizardReviewAlways ?? preferences.reviewAlways ?? false;
  if (preferences.policy !== undefined && preferences.policy !== DEFAULT_EXECUTION_POLICY) {
    deps.stdout(`  Execution policy: ${describeExecutionPolicy(preferences.policy)} — remembered from your last session here. /policy changes it.\n`);
  }
  // Said only when it is on: a default nobody chose does not need announcing, and a preference
  // that changes what every write costs does.
  if (reviewAlways && wizardReviewAlways === null) deps.stdout("  Reviewer on every write: on. /review off changes it.\n");
  deps.stdout("  Type a request, or /help. Nothing is spent until you confirm.\n\n");

  // The thread from earlier today, if there is one. It lives with this workspace's own state, so
  // another workspace in another terminal has its own and neither can see the other's.
  const session = new SessionContext(threadOptions(workspaceScope));
  if (session.resumed > 0) {
    deps.stdout(`  Continuing a thread of ${String(session.resumed)} earlier ${session.resumed === 1 ? "turn" : "turns"}. /forget starts fresh.\n\n`);
  }
  const providers = new ProviderSnapshotCache();
  // The goal this session continues. One conversation per workspace, opened on the first run and
  // resumed by every run after it, which is what makes closing the terminal not the same as
  // changing the subject. Everything it holds is this workspace's execution state: what was asked,
  // what came back, which files it touched. Another workspace of the same project has its own.
  const goals = openGoalStore(workspaceScope);
  const ledger = openLedger(workspaceScope);
  let current: GoalRecord | null = null;
  let activeGoalId: string | null = null;
  if (goals !== null) {
    const conversation = goals.openConversation();
    const resumed = goals.activeGoal(conversation.conversationId);
    if (resumed !== null) {
      current = resumed;
      activeGoalId = resumed.goalId;
      deps.stdout(`  Goal ${resumed.goalId.slice(0, 8)} · ${resumed.objective}\n`);
      deps.stdout(`  ${resumed.state.status}${resumed.state.acceptedFindings.length === 0 ? "" : ` · ${String(resumed.state.acceptedFindings.length)} established finding(s)`} · /goal for detail, /new to start a different one.\n\n`);
    }
  }
  // The installed build per provider, as discovery reads it. A session recorded against a different
  // version is not resumed on a guess: the mismatch is reported and a new session is started, which
  // is cheap, instead of resuming into a format this build may no longer read.
  const versions = new Map<string, string | null>();
  const probe = new SessionCapabilityProbe(deps.probeCapabilities, (providerId) => versions.get(providerId) ?? null);
  // DIRECT is the ordinary interactive boundary: the workspace itself, no worktree, no snapshot
  // (ADR 0017). The strict modes remain one command away and are never chosen for the operator.
  //
  // What the operator chose last time is honoured over that default, because `/policy worktree`
  // and `/review on` are decisions about this workspace rather than about this process. The
  // wizard's answer wins over the file only in the session that just ran it, where the file was
  // written a moment ago anyway.
  const worker: WorkerLoopState = {
    selection: AUTO_WORKER,
    policy: preferences.policy ?? DEFAULT_EXECUTION_POLICY,
    reviewAlways,
    preferencesPath,
    freshRequested: false,
    lastRun: null,
    lastWhy: null,
    probe,
    versions,
  };
  try {
    for (;;) {
      const line = await deps.ask("> ");
      if (line === null) return 0;
      const input = line.trim();
      if (input.length === 0) continue;
      if (input.startsWith("/")) {
        if (await runSlash(input, deps, session, goals, ledger, worker, workspaceScope) === "exit") return 0;
        // `/new` abandons the current goal, so the cached record must follow it rather than
        // describing a goal this session no longer continues.
        if (goals !== null && activeGoalId !== null && goals.getGoal(activeGoalId)?.state.status === "abandoned") {
          current = null;
          activeGoalId = null;
        }
        continue;
      }
      // The whole of M20's behavioural change, in one line: a request continues the current goal
      // unless the current goal is finished, in which case it starts one. It used to start a fresh
      // task every time, classified from the sentence alone.
      const goal = goals === null ? null : goals.continueOrCreateGoal({
        conversationId: goals.openConversation().conversationId,
        request: input,
        goalId: current?.goalId ?? null,
      });
      await runPlanned(input, deps, session, providers, goal, goals, ledger, worker);
      // The goal the next request will continue. Re-read after the turn, because the turn changed
      // it: the next plan must be built from the state the last answer produced, not from the state
      // it started in.
      if (goals !== null && goal !== null) {
        activeGoalId = goal.goalId;
        current = goals.getGoal(goal.goalId) ?? current;
      }
    }
  } finally {
    goals?.close();
    ledger?.close();
  }
}

/**
 * Where this workspace's goals live, or nowhere.
 *
 * A goal belongs to a workspace — the directory whose files it reasons about — so it needs a
 * registered project *and* the workspace scope that project is running in here. Without one, or if
 * resolving it fails, the session runs exactly as it did before M20, in memory, rather than refusing
 * to start because a store could not be opened. A feature that is missing is a smaller problem than
 * a terminal that will not open.
 */
function openGoalStore(scope: ExecutionScope | null): GoalStore | null {
  if (scope === null) return null;
  try { return new GoalStore(scope.project); } catch { return null; }
}

/** The task ledger, for reading which work units belong to a goal. Same availability rules. */
function openLedger(scope: ExecutionScope | null): TaskLedger | null {
  if (scope === null) return null;
  try { return new TaskLedger(scope.project); } catch { return null; }
}

export async function runReplOnTerminal(cwd: string): Promise<number> {
  const env = process.env;
  const dumb = env.TERM === "dumb";
  /**
   * The session's input, taken over rather than read through readline.
   *
   * Node's readline cannot tell a newline inside a paste from an Enter: with `terminal: true` it
   * strips the bracketed-paste markers and emits one `line` event per newline, so a pasted
   * paragraph looks exactly like somebody pressing Enter repeatedly. Measured on this stack before
   * this was written; see `prompt-input.ts`. The composer below reads the raw stream, where the
   * markers still exist, so the paste boundary is a fact rather than a guess.
   */
  const promptInput = createPromptInput({
    input: process.stdin,
    write: (text) => { process.stdout.write(text); },
    terminal: !dumb && process.stdin.isTTY === true,
    // `/` opens the command list under the draft, and Tab completes it — from the same table /help prints.
    suggest: slashSuggestions,
  });
  try {
    // A dumb terminal gets no escape sequences: no bracketed paste, no raw mode. Typing still works,
    // and a pipe still delivers one line per Enter.
    return await runRepl({
      cwd,
      animate: !dumb && env.BRAINGATE_NO_ANIMATION !== "1",
      colour: !dumb && (env.NO_COLOR === undefined || env.NO_COLOR === ""),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      ask: (question) => promptInput.ask(question),
      probeCapabilities: probeCapabilitiesFor,
    });
  } finally {
    promptInput.close();
  }
}
