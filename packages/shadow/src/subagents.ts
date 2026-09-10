import type { WorkflowRole } from "@braingate/workflows";

/**
 * The helpers BrainGate hands a run, when the grant allows any.
 *
 * The reason these are written here rather than left to the provider is the whole difference
 * between fan-out and an escape. A CLI's own subagents inherit the session's reach and answer to
 * nobody BrainGate can name; a definition BrainGate supplies says what the helper is for and
 * which tools it may touch, so the fan-out stays inside the lead's grant.
 *
 * They are deliberately few. A helper exists here when it does something the lead genuinely
 * should not spend its own context on — reading widely, checking a claim — and not otherwise.
 */
export interface SubagentDefinition {
  readonly description: string;
  readonly prompt: string;
  readonly tools: readonly string[];
}

const READ_ONLY_TOOLS = Object.freeze(["Read", "Grep", "Glob"]);

const EXPLORER: SubagentDefinition = Object.freeze({
  description: "Reads widely across the codebase and reports what it found, without changing anything.",
  prompt: [
    "You search and read files, and report findings with concrete paths.",
    "You never edit files, run commands, or reach the network.",
    "Report what you actually read. If you did not find something, say so rather than inferring it.",
  ].join(" "),
  tools: READ_ONLY_TOOLS,
});

const VERIFIER: SubagentDefinition = Object.freeze({
  description: "Checks one specific claim against the files, and reports whether it holds.",
  prompt: [
    "You are given a claim about this codebase. Check it by reading the relevant files.",
    "Answer whether it holds, with the path and line that decides it.",
    "You never edit files, run commands, or reach the network.",
    "A claim you cannot check is reported as unchecked, never as confirmed.",
  ].join(" "),
  tools: READ_ONLY_TOOLS,
});

/**
 * Subagent definitions for a role, keyed by name.
 *
 * The map shape is what both CLIs that accept definitions want: Claude documents
 * `{"name": {...}}`, and Grok rejects a JSON array with "expected a map" — measured, not assumed.
 */
export function braingateSubagents(role: WorkflowRole): Readonly<Record<string, SubagentDefinition>> {
  if (role === "planner" || role === "primary") return Object.freeze({ "braingate-explorer": EXPLORER });
  if (role === "reviewer") return Object.freeze({ "braingate-explorer": EXPLORER, "braingate-verifier": VERIFIER });
  // A judge decides between two answers it was given. Sending it to read more is a different
  // job than the one it was routed for.
  return Object.freeze({});
}

export function subagentsArgument(role: WorkflowRole): string | null {
  const definitions = braingateSubagents(role);
  return Object.keys(definitions).length === 0 ? null : JSON.stringify(definitions);
}

export function subagentNames(role: WorkflowRole): readonly string[] {
  return Object.freeze(Object.keys(braingateSubagents(role)));
}
