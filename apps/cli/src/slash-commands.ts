/**
 * The session's slash commands, as one table.
 *
 * Both readers of it — `/help`, which prints them, and the composer's menu, which offers them as
 * `/` is typed — take it from here, so a command cannot be documented in one place and unknown in
 * the other. The dispatch itself stays in `repl.ts`; this is what a person can see and complete.
 */
export interface SlashCommand {
  /** The name after the slash. */
  readonly name: string;
  /** Other names the dispatcher accepts for the same command, not offered by the menu. */
  readonly aliases?: readonly string[];
  /** The arguments, as shown, or empty for a command that takes none. */
  readonly args?: string;
  /** One line, in the operator's terms. */
  readonly hint: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: "use", args: "<provider>/<model> [--fresh]", hint: "send the next work to this worker" },
  { name: "auto", hint: "let BrainGate choose again" },
  { name: "worker", hint: "who is selected, what the goal is, and what the next run would resume" },
  { name: "goal", hint: "the current goal, its established findings and its open questions" },
  { name: "new", hint: "set the current goal aside and start a different one" },
  { name: "remember", args: "<text>", hint: "record something about this project, for later sessions" },
  { name: "memory", hint: "what is remembered, and what is waiting for your evidence" },
  { name: "status", hint: "recent tasks in this project" },
  { name: "project", hint: "which checkout this session is bound to, and where it is registered" },
  { name: "policy", args: "[direct|worktree|...]", hint: "the execution policy the next run uses" },
  { name: "review", args: "[on|off]", hint: "ask for a reviewer on every write, not only the risky ones" },
  { name: "setup", hint: "run the first-run wizard again: models, acceptances, review" },
  { name: "models", hint: "configured models and reviewer independence" },
  { name: "providers", hint: "which CLIs are installed, and which role each may take here" },
  { name: "doctor", hint: "validate project, models and reviewer isolation" },
  { name: "forget", hint: "drop this session's thread (project memory is untouched)" },
  { name: "feedback", args: "<task-id> <T0-T4> <success|partial|failure>", hint: "label a finished task" },
  { name: "help", aliases: ["?"], hint: "this list" },
  { name: "exit", aliases: ["quit", "q"], hint: "leave the session" },
]);

/** What the composer shows under a draft, and what Tab puts in its place. */
export interface SlashSuggestion {
  readonly label: string;
  readonly hint: string;
  /** The draft after completion: the command, and a space when it takes arguments. */
  readonly insert: string;
}

/**
 * The commands a draft could become, in the table's order.
 *
 * Only for a draft that is a slash command being typed: one line, starting with `/`, no space yet
 * (once the arguments start, the operator knows which command they are on). An exact match is still
 * offered alone, so Tab on `/goal` adds nothing and the hint stays visible.
 */
export function slashSuggestions(draft: string): readonly SlashSuggestion[] {
  if (!draft.startsWith("/") || draft.includes("\n") || draft.includes(" ")) return Object.freeze([]);
  const typed = draft.slice(1).toLowerCase();
  return Object.freeze(SLASH_COMMANDS
    .filter((command) => command.name.startsWith(typed))
    .map((command) => Object.freeze({
      label: `/${command.name}${command.args === undefined ? "" : ` ${command.args}`}`,
      hint: command.hint,
      insert: `/${command.name}${command.args === undefined ? "" : " "}`,
    })));
}
