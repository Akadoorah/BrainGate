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
import { GoalStore, buildGoalContext, inheritedComplexityFloor, renderHandoff, type GoalRecord } from "@braingate/goals";
import { resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type {
  CodexIsolationAttestation,
  GrokIsolationAttestation,
  MeasuredCapabilities,
  ShadowProcessExecutor,
  TaskSnapshotProvider,
} from "@braingate/shadow";
import type { WriteProviderExecutor } from "@braingate/write";
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

async function runPlanned(input: string, deps: ReplDeps, session: SessionContext, providers: ProviderSnapshotCache, goal: GoalRecord | null, goals: GoalStore | null, ledger: TaskLedger | null): Promise<void> {
  const mode = looksLikeWriteRequest(input) ? "write" : "ask";
  const captured: string[] = [];
  const capture = (text: string): void => { captured.push(text); };
  const sessionTurns = (budget: number) => session.recent(budget);
  // One probe for the whole request. Beyond the seconds it saves, it is what makes the plan the
  // operator approved and the run that follows describe the same machine.
  const discoverAll = providers.lease();

  // The goal layer, if this session has one. It is attached to the *plan* as well as the run: the
  // plan is what the operator approves, and a plan that routed a follow-up as a standalone T1 while
  // the run then inherited T3 would be describing a task nobody agreed to.
  const goalLayers = goal === null || goals === null ? null : goalContextFor(goals, goal, input, 24_000, ledger === null ? [] : ledger.listTasksForGoal(goal.goalId).map((task) => task.taskId));
  // The floor this request inherits from the goal it continues. `T0` is "no floor", which is both
  // the honest reading of a goal with nothing established and the value that leaves the classifier
  // exactly as it was before M20.
  const floor = goal === null ? "T0" : inheritedComplexityFloor(goal.state);
  const goalDeps = goal === null || goalLayers === null ? {} : {
    goalContext: goalLayers.context,
    goalId: goal.goalId,
    conversationId: goal.conversationId,
    inheritedComplexity: floor,
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
      goals.recordTurn({
        conversationId: goal.conversationId,
        goalId: goal.goalId,
        taskId,
        request: input,
        answer,
        attributedTo: attributed,
      });
      // The goal as the store has it *now*, not as it was when this turn started. The record read
      // before the run is a snapshot from before the run, and folding progress into a snapshot is
      // how a goal stays `open` after it has been answered.
      recordGoalProgress(goals, goals.getGoal(goal.goalId) ?? goal, input);
    }
  }
  // The exit code is reported, not interpreted. Inventing "completed but needs your review" here
  // was a guess about a task this layer never looked at: a non-zero exit can mean a blocked review,
  // a provider refusal, or a run that recorded nothing at all, and those need different responses.
  if (result.exitCode !== 0) deps.stdout("\n  Exit 1: this task did not finish successfully. Run `tasks list` to see what was recorded.\n\n");
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

async function runSlash(line: string, deps: ReplDeps, session: SessionContext, goals: GoalStore | null, ledger: TaskLedger | null): Promise<"continue" | "exit"> {
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
  try {
    for (;;) {
      const line = await deps.ask("> ");
      if (line === null) return 0;
      const input = line.trim();
      if (input.length === 0) continue;
      if (input.startsWith("/")) {
        if (await runSlash(input, deps, session, goals, ledger) === "exit") return 0;
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
      await runPlanned(input, deps, session, providers, goal, goals, ledger);
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
export async function runReplOnTerminal(cwd: string): Promise<number> {
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const env = process.env;
    const dumb = env.TERM === "dumb";
    return await runRepl({
      cwd,
      animate: !dumb && env.BRAINGATE_NO_ANIMATION !== "1",
      colour: !dumb && (env.NO_COLOR === undefined || env.NO_COLOR === ""),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      ask: async (question) => {
        try { return await rl.question(question); }
        catch { return null; }
      },
    });
  } finally {
    rl.close();
  }
}
