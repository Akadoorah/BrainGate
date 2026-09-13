/**
 * What the operator is asking for, decided from the requested effect.
 *
 * This exists because real dogfood classified a write as a read, twice, deterministically:
 *
 * ```text
 * Apply the agreed harmless comment-only change to the selected README file.
 * Modify only that file, do not commit, do not create a branch, do not use git reset, …
 * ```
 *
 * The old rule was `^\s*(add|append|change|…)\b` — a write verb at the *start* of the request, from a
 * list that did not contain "apply" or "modify". Two things were wrong with it, and only fixing both
 * makes the class of bug go away:
 *
 * 1. **Position.** A write verb can follow a qualifier ("Now apply…", "Please change…") or a first
 *    line, and the request is still a write.
 * 2. **Constraints are not negations of the effect.** "Do not commit", "do not create a branch",
 *    "do not use git reset" bound *how* the change is made. Read as negations of the request, they
 *    turned a write into a read — and worse, the read was then given to a native session that had
 *    been created under a standing "analyze only; do not modify files" instruction, which refused it.
 *
 * So the rule is about the requested effect:
 *
 * - a write verb, in a clause that is neither negated nor hypothetical, asks for a change;
 * - a verb under a negative constraint ("do not modify anything", "without creating a branch") is
 *   part of the boundary, not the request;
 * - a question about how something *would* be done asks for an answer, not for the change.
 *
 * Getting this wrong in the other direction is safe by construction — the mode is named in the
 * confirmation line before anything runs — but it is also the difference between a write that
 * happens and a write that is refused by a session that was told not to touch anything.
 */

/** Verbs whose object is a change to the workspace. */
const WRITE_VERBS: readonly string[] = Object.freeze([
  // `comment` is deliberately absent: as a noun it is everywhere ("confirm the comment is there"),
  // and as a verb it is rare enough that the surrounding words — add, append, insert, apply — carry
  // the directive. It produced a false WRITE on a read request in the acceptance scenario.
  "add", "adjust", "annotate", "append", "apply", "bump", "change", "clean", "cleanup",
  "convert", "correct", "create", "delete", "document", "drop", "edit", "extract", "fix", "format",
  "implement", "improve", "inline", "insert", "migrate", "modify", "move", "patch", "polish",
  "refactor", "remove", "rename", "reorder", "replace", "restore", "rewrite", "set", "simplify",
  "split", "swap", "tidy", "trim", "update", "upgrade", "write",
]);

/**
 * Words that make a clause a question or a hypothesis rather than an instruction.
 *
 * "Tell me how you would implement it" contains a write verb and asks for nothing to be written.
 * These are matched against the text *before* the verb, because that is where the framing lives.
 */
const HYPOTHETICAL_FRAMES: readonly RegExp[] = Object.freeze([
  /\bhow (would|do|does|can|could|should|might) (you|i|we|one|it)\b/i,
  /\bhow to\b/i,
  /\bwhat would (you|need|have to)\b/i,
  /\bwhat (needs?|would need) to change\b/i,
  /\bwhere (is|are|would)\b/i,
  /\btell me how\b/i,
  /\bexplain how\b/i,
  /\bdescribe how\b/i,
  /\bwalk me through how\b/i,
  /\bsuggest how\b/i,
  /\bwould you\b/i,
  /\bshould i\b/i,
  /\bwhat('s| is) the (best|right) way\b/i,
]);

/** Words that make a write verb part of a boundary rather than a request. */
const NEGATIONS: readonly RegExp[] = Object.freeze([
  /\b(do not|don't|does not|doesn't|never|without|avoid|no)\s+(\w+\s+){0,3}$/i,
  /\bnot\s+(\w+\s+){0,2}$/i,
]);

/**
 * Clauses, so a negation or a frame is judged where it appears rather than across the whole request.
 *
 * Splitting on sentence and list punctuation is what keeps "Modify only that file, do not commit"
 * apart: the first clause asks for the change, the second bounds it.
 */
function clauses(text: string): readonly string[] {
  return Object.freeze(text.split(/[\n;.•]|(?<=[.!?])\s+|,\s+(?=(?:and\s+)?(?:do not|don't|never|without|but)\b)/i).map((clause) => clause.trim()).filter((clause) => clause.length > 0));
}

/** Whether the clause is a question rather than an instruction. */
function isInterrogative(clause: string): boolean {
  return /\?\s*$/.test(clause.trim()) || /^\s*(which|what|where|who|when|why|how|is|are|does|do|can|could|should|would)\b/i.test(clause);
}

/** Whether the write verb at `index` is governed by a negation or a hypothetical frame. */
function isBounded(clause: string, index: number): boolean {
  const before = clause.slice(0, index);
  // A write verb in the infinitive, inside a question, is what the question is *about*: "which file
  // is safest to change?" asks for an answer, not for a change. Real usage produced exactly that
  // phrasing, and it was the first turn of the acceptance scenario.
  if (isInterrogative(clause) && /\bto\s*$/i.test(before)) return true;
  // A negation in the same clause, close enough to govern this verb: "do not use git reset", "without
  // creating a branch". Distance is bounded so an earlier constraint cannot silence a later verb.
  if (NEGATIONS.some((pattern) => pattern.test(before))) return true;
  return HYPOTHETICAL_FRAMES.some((pattern) => pattern.test(before)) || HYPOTHETICAL_FRAMES.some((pattern) => pattern.test(clause));
}

export type RequestIntent = "read" | "write";

/**
 * The requested effect of a request: a change to the workspace, or an answer about it.
 *
 * Deterministic and cheap: no model, no history, no scoring. Everything the operator can do in the
 * session is behind a confirmation that names this mode, so the cost of being wrong is a visible
 * line and a `n`, not a wrong action.
 */
export function classifyRequestIntent(text: string): RequestIntent {
  for (const clause of clauses(text)) {
    const verb = new RegExp(`\\b(${WRITE_VERBS.join("|")})\\b`, "gi");
    // Every occurrence, not just the first: a clause can bound one verb and still ask for another
    // ("without touching the config, add the flag").
    for (let match = verb.exec(clause); match !== null; match = verb.exec(clause)) {
      if (!isBounded(clause, match.index)) return "write";
    }
  }
  return "read";
}
