import { existsSync } from "node:fs";
import { basename } from "node:path";
import { findManifest } from "./manifest-path.js";
import { createInterface, type Interface } from "node:readline/promises";
import { runCli } from "./cli.js";
import { runDogfoodCli } from "./dogfood-cli.js";
import { runMemoryCli } from "./memory-cli.js";
import { ProviderSnapshotCache } from "./provider-cache.js";
import { SessionContext, sessionThreadPath } from "./session-context.js";
import { ProjectRegistry } from "@braingate/core";
import { resolveOperatorState } from "@braingate/operator";
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

async function runPlanned(input: string, deps: ReplDeps, session: SessionContext, providers: ProviderSnapshotCache): Promise<void> {
  const mode = looksLikeWriteRequest(input) ? "write" : "ask";
  const captured: string[] = [];
  const capture = (text: string): void => { captured.push(text); };
  const sessionTurns = (budget: number) => session.recent(budget);
  // One probe for the whole request. Beyond the seconds it saves, it is what makes the plan the
  // operator approved and the run that follows describe the same machine.
  const discoverAll = providers.lease();

  const planning = startProgress({ write: deps.stdout, label: "planning", ...progressStyle(deps) });
  const plan = await runDogfoodCli(["dogfood", mode, "plan", "--task", input], {
    cwd: deps.cwd, stdout: capture, stderr: capture, sessionTurns, discoverAll,
  });
  planning.stop();
  const planText = captured.join("");
  const summary = firstLine(planText);
  if (plan.exitCode !== 0) { deps.stderr(`${planText}\n`); return; }

  deps.stdout(`\n  ${mode === "write" ? "write · isolated worktree" : "read-only"} · ${summary}\n`);
  // What each role may do, and what it asked for and did not get. This is the half of the plan
  // that used to be dropped, and it is the half that answers "why is this reading less than I
  // expected" before the run rather than after it.
  for (const line of grantLines(planText)) deps.stdout(`  ${line}\n`);
  const answer = await deps.ask(mode === "write" ? "  Run it? This changes a task worktree, never your checkout. [y/N] " : "  Run it? [y/N] ");
  if (answer === null || !/^y(es)?$/i.test(answer.trim())) { deps.stdout("  Skipped. Nothing was spent.\n\n"); return; }

  deps.stdout("\n");
  const spoken: string[] = [];
  // The indicator has to be gone before the first byte of real output, or the two share a line.
  const working = startProgress({ write: deps.stdout, label: mode === "write" ? "writing" : "working", ...progressStyle(deps) });
  // A streamed answer is written straight to the terminal as the model produces it, and the
  // final print would then repeat every word of it. This tracks whether that happened.
  let streamed = false;
  const result = await runDogfoodCli(["dogfood", mode, "run", "--task", input, "--execute"], {
    cwd: deps.cwd,
    stdout: (text) => {
      working.stop();
      spoken.push(text);
      // The answer is already on screen; what is left to print is the receipt after it.
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
  });
  if (streamed) deps.stdout("\n");
  working.stop();
  // Only a clean result joins the thread. A failed or rejected task would otherwise become the
  // premise of the next follow-up.
  if (result.exitCode === 0) session.record(input, spoken.join("").replace(/\n*Task [0-9a-f-]{36}.*$/s, "").trim());
  deps.stdout(result.exitCode === 0 ? "\n" : "\n  Exit 1: completed but needs your review.\n\n");
}

async function runSlash(line: string, deps: ReplDeps, session: SessionContext): Promise<"continue" | "exit"> {
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
        "  Follow-ups resolve against earlier turns. That thread is kept with this project's own",
        "  state for a few hours, redacted, and never becomes project memory. /forget deletes it.",
        "",
        "  /remember <text>  record something about this project, for later sessions",
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
    const init = await runDogfoodCli(["init"], { cwd: deps.cwd, stdout: deps.stdout, stderr: deps.stderr, ask: deps.ask, quiet: true });
    if (init.exitCode !== 0) return init.exitCode;
    deps.stdout("\n");
  }

  const header: string[] = [];
  await runDogfoodCli(["dogfood", "preflight"], { cwd: deps.cwd, stdout: (t) => header.push(t), stderr: (t) => header.push(t) });
  deps.stdout(`  ${firstLine(header.join(""))}\n  Type a request, or /help. Nothing is spent until you confirm.\n\n`);

  // The thread from earlier today, if there is one. It lives with the project's own state, so a
  // different project in another terminal has its own and neither can see the other's.
  const session = new SessionContext(threadOptions(deps.cwd, deps.env));
  if (session.resumed > 0) {
    deps.stdout(`  Continuing a thread of ${String(session.resumed)} earlier ${session.resumed === 1 ? "turn" : "turns"}. /forget starts fresh.\n\n`);
  }
  const providers = new ProviderSnapshotCache();
  for (;;) {
    const line = await deps.ask("> ");
    if (line === null) return 0;
    const input = line.trim();
    if (input.length === 0) continue;
    if (input.startsWith("/")) {
      if (await runSlash(input, deps, session) === "exit") return 0;
      continue;
    }
    await runPlanned(input, deps, session, providers);
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
