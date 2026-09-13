import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { findManifest } from "./manifest-path.js";
import { createInterface, type Interface } from "node:readline/promises";
import { runCli } from "./cli.js";
import { runDogfoodCli } from "./dogfood-cli.js";
import { runMemoryCli } from "./memory-cli.js";
import { ProviderSnapshotCache } from "./provider-cache.js";
import { SessionContext, sessionThreadPath } from "./session-context.js";
import { ProjectRegistry, TaskLedger } from "@braingate/core";
import {
  GoalStore,
  buildGoalContext,
  describeGoalDelta,
  describeSessionDecision,
  inheritedComplexityFloor,
  renderHandoff,
  type GoalRecord,
  type NativeSessionDecision,
} from "@braingate/goals";
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

const WRITE_INTENT = /^\s*(add|append|change|convert|correct|create|delete|drop|edit|extract|fix|implement|inline|insert|migrate|move|refactor|remove|rename|reorder|replace|rewrite|set|split|swap|update|write)\b/i;

/**
 * Guesses whether free text asks for a change rather than an answer.
 *
 * A wrong guess is safe by construction: the mode is named in the confirmation line before
 * anything runs, so the operator sees "write" and can decline. Detection is a convenience, and
 * the confirmation — not this regular expression — is what protects the checkout.
 */
export function looksLikeWriteRequest(text: string): boolean {
  return WRITE_INTENT.test(text);
}

function progressStyle(deps: ReplDeps): { style: typeof PLAIN_PROGRESS; animate: boolean } {
  return { style: deps.colour === false ? PLAIN_PROGRESS : COLOURED_PROGRESS, animate: deps.animate !== false };
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

/**
 * Where this directory's session thread belongs, or nowhere.
 *
 * A thread is project state, so it needs a registered project to belong to. Without one — or if
 * anything about resolving it fails — the session simply keeps its thread in memory, which is
 * what it always did.
 */
function threadOptions(cwd: string, env: NodeJS.ProcessEnv | undefined): { readonly path?: string } {
  try {
    const state = resolveOperatorState(env ?? process.env);
    const manifest = findManifest(cwd);
    if (!existsSync(manifest)) return {};
    const project = new ProjectRegistry(state.home).loadFile(manifest);
    return { path: sessionThreadPath(project.storageDir) };
  } catch {
    return {};
  }
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
 * How a working role reads in the indicator: what it is doing, on which model.
 *
 * The quota pool rather than the provider id, because that is the thing being spent, and two
 * models from one subscription share it.
 */
export function activityLabel(activity: { readonly role: string; readonly model: string; readonly quotaPool: string }): string {
  const verb = activity.role === "planner" ? "planning" : activity.role === "reviewer" ? "reviewing" : activity.role === "judge" ? "judging" : "working";
  return `${verb} · ${activity.model} · ${activity.quotaPool}`;
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
  async pinning(providerId: string): Promise<boolean | "unknown" | null> {
    if (this.probe === undefined) return null;
    const known = this.#readings.get(providerId);
    if (known !== undefined) return known;
    const inFlight = this.#pending.get(providerId);
    if (inFlight !== undefined) return await inFlight;
    const promise = this.#read(providerId);
    this.#pending.set(providerId, promise);
    const value = await promise;
    this.#pending.delete(providerId);
    return value;
  }

  async #read(providerId: string): Promise<boolean | "unknown"> {
    try {
      const report = await this.probe?.(providerId);
      const supported = report?.features.sessionIdPinning?.supported ?? "unknown";
      this.#readings.set(providerId, supported);
      return supported;
    } catch {
      // A probe that could not run answers `unknown`, and an unknown refuses continuity. Silence
      // must never be able to grant a capability.
      this.#readings.set(providerId, "unknown");
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
  const value = data as { readonly summary?: unknown; readonly complexity?: unknown; readonly promptComplexity?: unknown; readonly grantLines?: unknown };
  if (typeof value.summary !== "string" || typeof value.complexity !== "string" || typeof value.promptComplexity !== "string") return null;
  const grants = Array.isArray(value.grantLines) ? value.grantLines.filter((line): line is string => typeof line === "string") : [];
  return Object.freeze({ summary: value.summary, complexity: value.complexity, promptComplexity: value.promptComplexity, grantLines: Object.freeze(grants) });
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
 * Marking the goal `diagnosed` is therefore an evidence claim and not a reading of the prose: a goal
 * with a finished turn has a result, which is the same threshold ADR 0013's coherence check uses.
 * Nothing is inferred from whether the answer *sounds* like a diagnosis.
 *
 * What this deliberately does not do is accept a finding. Going from "a turn finished" to "this is
 * what is true" is `applyGoalStateUpdate`'s gate, and a worker cannot reach it from here: a
 * conclusion becomes established when the operator or the evidence says so, which is exactly the
 * distinction this whole layer exists to keep.
 */
function recordGoalProgress(store: GoalStore, goal: GoalRecord, input: string): void {
  store.updateGoalState(goal.goalId, {
    status: goal.state.status === "open" ? "diagnosed" : goal.state.status,
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
  /** Mutated by `/use --fresh`: consumed by exactly one run. */
  freshRequested: boolean;
  /** What the last run did about a native session, for `/worker`. */
  lastRun: RunSessionSummary | null;
  readonly probe: SessionCapabilityProbe;
  /** The installed build per provider, filled by discovery as it runs. */
  readonly versions: Map<string, string | null>;
}

async function runPlanned(input: string, deps: ReplDeps, session: SessionContext, providers: ProviderSnapshotCache, goal: GoalRecord | null, goals: GoalStore | null, ledger: TaskLedger | null, worker: WorkerLoopState): Promise<void> {
  const mode = looksLikeWriteRequest(input) ? "write" : "ask";
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
    probedPinning: (providerId) => worker.probe.pinning(providerId),
    runtimeVersion: (providerId) => worker.probe.runtimeVersion(providerId),
    workspace: () => deps.cwd,
    onResolved: (summary) => { worker.lastRun = summary; },
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
  };

  const planning = startProgress({ write: deps.stdout, label: "planning", ...progressStyle(deps) });
  // No `--json`: how a result is rendered is the surface's business, and this surface is a person.
  // The classification the plan *used* comes back as structure regardless, which is what the lines
  // below need — reading it back off the printed summary meant a tier was visible only when the
  // renderer happened to mention it.
  const plan = await runDogfoodCli(["dogfood", mode, "plan", "--task", input], {
    cwd: deps.cwd, stdout: capture, stderr: capture, sessionTurns, discoverAll, ...runtimeDeps(deps), ...goalDeps,
  });
  planning.stop();
  const planText = captured.join("");
  // A plan that could not be built exits non-zero, and its output is the diagnosis rather than
  // JSON; only a successful plan is parsed.
  if (plan.exitCode !== 0) { deps.stderr(`${planText}\n`); return; }
  const planJson = readPlan(plan.data);
  const planSummary = planJson === null ? "the plan produced no readable output" : planJson.summary;

  deps.stdout(`\n  ${mode === "write" ? "write · isolated worktree" : "read-only"} · ${planSummary}\n`);
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
  const answer = await deps.ask(mode === "write" ? "  Run it? This changes a task worktree, never your checkout. [y/N] " : "  Run it? [y/N] ");
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
  // The run's record — task id, outcome, usage, the answer — comes back as data without asking for
  // JSON, and the human-readable answer is what the operator sees.
  const result = await runDogfoodCli(["dogfood", mode, "run", "--task", input, "--execute"], {
    cwd: deps.cwd,
    stdout: (text) => {
      working.stop();
      spoken.push(text);
      // The answer is already on screen; what is left to print is the receipt after it. The record
      // itself travels in `result.data`, so this decides display and nothing else.
      deps.stdout(streamed ? withoutStreamedAnswer(text) : text);
    },
    stderr: (text) => { working.stop(); deps.stderr(text); },
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
  // Only a clean result joins the thread. A failed or rejected task would otherwise become the
  // premise of the next follow-up.
  if (result.exitCode === 0) session.record(input, spoken.join("").replace(/\n*Task [0-9a-f-]{36}.*$/s, "").trim());
  // The goal's own record of the turn, on the same terms: a clean result, and nothing at all when
  // the run failed. What this buys is that the *next* turn — tomorrow, on another provider, after
  // this process is gone — is a continuation rather than a new question.
  if (result.exitCode === 0 && goal !== null && worker.lastRun?.session != null) {
    const decision = worker.lastRun.session;
    if (decision.kind !== "disabled") {
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

async function runSlash(line: string, deps: ReplDeps, session: SessionContext, goals: GoalStore | null, ledger: TaskLedger | null, worker: WorkerLoopState): Promise<"continue" | "exit"> {
  const [command, ...rest] = line.slice(1).trim().split(/\s+/);
  const io = { cwd: deps.cwd, stdout: deps.stdout, stderr: deps.stderr };

  switch (command) {
    case "exit": case "quit": case "q":
      return "exit";
    case "help": case "?":
      deps.stdout([
        "",
        "  Type a request in plain words. A question is answered; an instruction to change",
        "  something is planned as a write into an isolated worktree. Either way you see the",
        "  plan and confirm before anything is spent.",
        "",
        "  Follow-ups continue the same goal. Every worker — whichever provider it is routed to —",
        "  is given the goal's established findings, what has changed and what is unresolved, so",
        "  switching models continues the work instead of restarting it.",
        "",
        "  /remember <text>  record something about this project, for later sessions",
        "  /goal       the current goal, its established findings and its open questions",
        "  /new        set the current goal aside and start a different one",
        "",
        "  Which worker does the work. A switch keeps the goal: the next worker is handed the",
        "  established findings, and a worker whose own session can be resumed is given only what",
        "  changed while it was away.",
        "",
        "  /use <provider>/<model> [--fresh]   send the next work to this worker",
        "  /auto       let BrainGate choose again",
        "  /worker     who is selected, what the goal is, and what the next run would resume",
        "  /memory     what is remembered, and what is waiting for your evidence",
        "  /status     recent tasks in this project",
        "  /models     configured models and reviewer independence",
        "  /providers  which CLIs are installed, and which role each may take here",
        "  /doctor     validate project, models and reviewer isolation",
        "  /forget     drop this session's thread (project memory is untouched)",
        "  /feedback <task-id> <T0-T4> <success|partial|failure>",
        "  /exit",
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
      if (goal === null) { deps.stdout("  No goal yet. The next request starts one.\n"); return "continue"; }
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
        const pinning = await worker.probe.pinning(worker.selection.providerId);
        if (pinning === true) deps.stdout("  Native session continuity: supported by the installed build.\n");
        else if (pinning === false) deps.stdout("  Native session continuity: this build does not publish a session-id flag, so each turn will be a fresh invocation with a goal handoff.\n");
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
    case "worker": {
      const goal = goals === null ? null : goals.activeGoal();
      const known = goals === null ? [] : goals.listProviderSessions(8);
      for (const line of describeWorker({ selection: worker.selection, goal, lastRun: worker.lastRun, knownSessions: known })) deps.stdout(`${line}\n`);
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
    case "status":
      await runCli(["status", "--project", ".brain/project.json"], io);
      return "continue";
    case "models":
      await runCli(["models", "profile"], io);
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

  // Arriving in an unregistered directory is the ordinary first run, not an error to be turned
  // away at. The banner has already said what this is; now offer the one command that starts,
  // rather than printing an instruction and exiting.
  if (!existsSync(findManifest(deps.cwd))) {
    deps.stdout([
      `  No BrainGate project in ${basename(deps.cwd)} yet.`,
      "  The project id is the isolation boundary for memory, worktrees and telemetry,",
      "  so it is registered explicitly rather than assumed.",
      "",
    ].join("\n"));
    const answer = await deps.ask("  Register this repository now? [Y/n] ");
    if (answer === null || /^n(o)?$/i.test(answer.trim())) {
      deps.stdout("\n  Nothing registered. Run `braingate init` here when you are ready.\n\n");
      return 1;
    }
    deps.stdout("\n");
    const init = await runDogfoodCli(["init"], { cwd: deps.cwd, stdout: deps.stdout, stderr: deps.stderr, ask: deps.ask, quiet: true, ...runtimeDeps(deps) });
    if (init.exitCode !== 0) return init.exitCode;
    deps.stdout("\n");
  }

  const header: string[] = [];
  await runDogfoodCli(["dogfood", "preflight"], { cwd: deps.cwd, stdout: (t) => header.push(t), stderr: (t) => header.push(t), ...runtimeDeps(deps) });
  deps.stdout(`  ${firstLine(header.join(""))}\n  Type a request, or /help. Nothing is spent until you confirm.\n\n`);

  // The thread from earlier today, if there is one. It lives with the project's own state, so a
  // different project in another terminal has its own and neither can see the other's.
  const session = new SessionContext(threadOptions(deps.cwd, deps.env));
  if (session.resumed > 0) {
    deps.stdout(`  Continuing a thread of ${String(session.resumed)} earlier ${session.resumed === 1 ? "turn" : "turns"}. /forget starts fresh.\n\n`);
  }
  const providers = new ProviderSnapshotCache();
  // The goal this session continues. One conversation per project, opened on the first run and
  // resumed by every run after it, which is what makes closing the terminal not the same as
  // changing the subject. Everything it holds is project state, in the project's own storage dir.
  const goals = openGoalStore(deps.cwd, deps.env);
  const ledger = openLedger(deps.cwd, deps.env);
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
  const worker: WorkerLoopState = { selection: AUTO_WORKER, freshRequested: false, lastRun: null, probe, versions };
  try {
    for (;;) {
      const line = await deps.ask("> ");
      if (line === null) return 0;
      const input = line.trim();
      if (input.length === 0) continue;
      if (input.startsWith("/")) {
        if (await runSlash(input, deps, session, goals, ledger, worker) === "exit") return 0;
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
 * Where this directory's goals live, or nowhere.
 *
 * A goal is project state, so it needs a registered project to belong to. Without one — or if
 * resolving it fails — the session runs exactly as it did before M20, in memory, rather than
 * refusing to start because a store could not be opened. A feature that is missing is a smaller
 * problem than a terminal that will not open.
 */
function openGoalStore(cwd: string, env: NodeJS.ProcessEnv | undefined): GoalStore | null {
  try {
    const state = resolveOperatorState(env ?? process.env);
    const manifest = findManifest(cwd);
    if (!existsSync(manifest)) return null;
    return new GoalStore(new ProjectRegistry(state.home).loadFile(manifest));
  } catch {
    return null;
  }
}

/** The task ledger, for reading which work units belong to a goal. Same availability rules. */
function openLedger(cwd: string, env: NodeJS.ProcessEnv | undefined): TaskLedger | null {
  try {
    const state = resolveOperatorState(env ?? process.env);
    const manifest = findManifest(cwd);
    if (!existsSync(manifest)) return null;
    return new TaskLedger(new ProjectRegistry(state.home).loadFile(manifest));
  } catch {
    return null;
  }
}

/** Wires the session to the real terminal. */
/**
 * How long a prompt waits, after its first line, to see whether the rest of a paste is still coming.
 *
 * A paste arrives as one burst, and Node delivers it as one `line` event per line. `rl.question`
 * resolves on the first of those and leaves the rest queued, so the *next* prompt — the
 * "Run it? [y/N]" — is handed the second line of the request the person had just pasted. In dogfood
 * that is exactly what happened: a two-line request, and the confirmation boundary showing
 * `Run it? [y/N] yKeep the answer concise…`, after which the task was skipped.
 *
 * It is a window rather than a queue because the two cases are otherwise indistinguishable: a human
 * who types two lines deliberately presses Enter twice, seconds apart, and must get two prompts.
 * Nobody notices 25 milliseconds; everybody notices their request being answered with a `y`.
 */
export const PASTE_BURST_MS = 25;

/**
 * Reads input one *prompt* at a time, keeping a pasted request whole.
 *
 * The alternative considered and rejected was to detect a bad answer at the confirmation — the
 * prompt already shows the spilled text, and by then the request is the thing that was mangled. This
 * keeps the request intact instead, which is the property the operator actually needs.
 */
export function createPromptInput(
  options: {
    /** Anything that emits `line`, `end` and `close`: a readline interface, or a test's input. */
    readonly input: { on(event: "line", listener: (line: string) => void): unknown; on(event: "end" | "close", listener: () => void): unknown };
    readonly write: (text: string) => void;
    readonly burstMs?: number;
  },
): { readonly ask: (question: string) => Promise<string | null>; readonly idle: () => Promise<void> } {
  const burstMs = options.burstMs ?? PASTE_BURST_MS;
  let pending: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;

  options.input.on("line", (line: string) => {
    if (waiter === null) { pending.push(line); return; }
    const resolve = waiter;
    waiter = null;
    resolve(line);
  });
  // Input ending is the end of the session, and a prompt waiting on it has to be let go: a closed
  // pipe that leaves a promise hanging is a process that never exits.
  const end = (): void => { const resolve = waiter; waiter = null; resolve?.(null); };
  options.input.on("end", end);
  options.input.on("close", end);

  const nextLine = async (): Promise<string | null> => {
    const queued = pending.shift();
    if (queued !== undefined) return queued;
    return await new Promise<string | null>((resolve) => { waiter = resolve; });
  };

  /**
   * The next line of this burst, or `null` once nothing has arrived for the length of the window.
   *
   * The queue is consulted first, and that is not an optimization: a paste delivered synchronously
   * puts its remaining lines in the queue *while* the first prompt is still resolving, so a window
   * that only listened would let them sit there — which is the original bug wearing a different hat.
   */
  const nextInBurst = async (): Promise<string | null> => {
    const queued = pending.shift();
    if (queued !== undefined) return queued;
    return await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => { if (waiter === settle) waiter = null; resolve(null); }, burstMs);
      const settle = (line: string | null): void => { clearTimeout(timer); resolve(line); };
      timer.unref();
      waiter = settle;
    });
  };

  const ask = async (question: string): Promise<string | null> => {
    options.write(question);
    const first = await nextLine();
    if (first === null) return null;
    const rest: string[] = [];
    // Whatever else this paste carried belongs to the same request. The window closes as soon as one
    // has passed with nothing arriving, which is what a person typing line by line looks like.
    for (;;) {
      const more = await nextInBurst();
      if (more === null) break;
      rest.push(more);
    }
    return rest.length === 0 ? first : [first, ...rest].join("\n");
  };

  /** Resolves once no line is waiting to be delivered. For tests, which cannot wait on a window. */
  const idle = async (): Promise<void> => {
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, burstMs * 2); timer.unref(); });
  };

  return Object.freeze({ ask, idle });
}

export async function runReplOnTerminal(cwd: string): Promise<number> {
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const env = process.env;
    const dumb = env.TERM === "dumb";
    // The prompt is written once, before the read, so a multi-line request is echoed as the single
    // thing the operator typed rather than as a prompt repeated per line.
    const promptInput = createPromptInput({
      input: rl,
      write: (text) => { process.stdout.write(text); },
    });
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
    rl.close();
  }
}
