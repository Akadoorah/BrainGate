/**
 * What the operator is asking for: an answer, or a change to the workspace.
 *
 * ## Why this is not a keyword search
 *
 * The first version looked for a write verb anywhere in the request, and real use broke it in both
 * directions at once: "hello after delete" was classified as a WRITE, and so was "state which provider
 * wrote marker 2 … and what happened to the cancelled write attempt" — a request to *report*, which
 * then ran the write path and failed. Every word that mattered in those sentences was a word being
 * talked *about*.
 *
 * Vocabulary cannot answer this question, because the same word is a request in one sentence and a
 * subject in the next. What separates them is structure:
 *
 *   1. **Is the clause a directive at all?** A request is imperative — the verb leads the clause — or
 *      it arrives through an explicit frame ("please …", "can you …", "I want you to …", "من فضلك"،
 *      "ممكن"). Questions, statements, negations, hypotheticals and quoted text are not directives,
 *      whatever vocabulary they contain.
 *   2. **If it is a directive, what does its head verb ask for?** Only a verb whose effect is a
 *      *change to the workspace* makes this a write. "read", "explain", "summarize" and "verify" are
 *      directives too; they ask for an answer.
 *
 * So delete, write, remove, auth, payment and checkout are inert unless one of them is the head verb
 * of a directive clause. In "hello after delete" the head is `hello`; in "what does delete mean?" the
 * clause is a question; in "why was \"remove auth middleware\" blocked?" the phrase is quoted. None of
 * them reaches the mutate list, and none of them is a write.
 *
 * ## What still counts
 *
 * `delete README.md`, `remove the auth middleware`, `احذف هذا الملف`, `عدل نظام المصادقة` — head verb,
 * imperative, mutating effect: WRITE, and every existing write protection applies exactly as before.
 * This module only decides whether the write path is entered; the risk gate inside it is untouched.
 * Because a false READ is the more dangerous of the two errors, a request phrased politely is still a
 * request: "can you delete the file?" is a write.
 *
 * On the Arabic side the lists hold imperative and second-person verb forms (`احذف`, `تحذف`, `عدل`,
 * `غير`, `أضف`) and never verbal nouns (`حذف`, `تعديل`). "شو يعني حذف الملف؟" says *deletion* — a thing
 * being asked about — and is not a request even before the question word is considered.
 */

export type RequestIntent = "read" | "write";

/**
 * Lead-ins that may precede an imperative without changing what it is.
 *
 * Kept short on purpose. Every word here is one a person can put in front of an instruction without
 * making it something else, and a content word is not in the list — that is the mechanism: "hello
 * after delete" has `hello` before `delete`, so `delete` is not the head and the sentence is not an
 * instruction.
 */
const LEAD_INS: readonly string[] = Object.freeze([
  "please", "now", "then", "also", "kindly", "first", "firstly", "second", "next", "finally", "just",
  "simply", "and", "but", "so", "go", "ahead", "ok", "okay", "hey", "hi", "well", "actually",
]);

/**
 * Frames that make a sentence a request even when it is phrased as a question.
 *
 * "can you delete the file?" is a request, and so is "can you explain this?" — the frame decides that
 * there is a request here, and the head verb decides which one. These are checked before the question
 * test, because the question mark is what makes the request polite rather than what makes it a
 * question.
 */
const REQUEST_FRAMES: readonly RegExp[] = Object.freeze([
  /\b(can|could|would|will)\s+you\b/i,
  /\b(i|we)\s+(want|need|would\s+like|'d\s+like)\s+(you\s+)?to\b/i,
  /\bplease\b/i,
  /\bgo\s+ahead\s+and\b/i,
  /\blet'?s\b/i,
  /من\s+فضلك/,
  /ممكن/,
  /هل\s+يمكنك/,
  /(أ|ا)ريد\s+(أن|ان)/,
  /بدي/,
  /لو\s+سمحت/,
]);

/**
 * Words that open a question: a clause starting with one is asking, whatever else it contains.
 *
 * "What would you change about this design?" contains a request frame ("would you") and is still a
 * question — the question word is what the sentence is *about*. That is why these are checked before
 * any frame, while the auxiliaries below are not.
 */
const WH_START = /^(what|which|where|who|whom|whose|when|why|how|شو|ايش|إيش|ما|ماذا|لماذا|ليش|كيف|هل|وين|أين|اين|متى|اي|أي)\b/i;

/** Auxiliaries that open a question — unless a request frame follows, as in "can you delete it?". */
const AUX_START = /^(is|are|was|were|am|does|do|did|has|have|had|can|could|should|would|will|may|might)\b/i;

/** The frames that make an auxiliary-led clause a request rather than a question. */
const FRAMED_START = /^(can|could|would|will)\s+you\b|^(please\b|من\s+فضلك|ممكن|هل\s+يمكنك)/i;

/**
 * What makes a clause a boundary rather than a request.
 *
 * A negation or a hypothetical in the same clause means the verb is being *talked about*: "do not
 * delete anything", "if you were to remove the middleware". Distance is bounded so an earlier
 * constraint cannot silence a later, separate instruction.
 */
const BOUNDING: readonly RegExp[] = Object.freeze([
  /\b(do not|don't|does not|doesn't|never|without|avoid|no)\s+(\w+\s+){0,3}$/i,
  /\bnot\s+(\w+\s+){0,2}$/i,
  /\b(if|whether|unless|suppose|supposing|assuming|imagine|hypothetically)\b/i,
  /(لا|بدون|دون)\s+(\S+\s+){0,2}$/,
  /(لو|اذا|إذا|إن|ان)\b/,
]);

/**
 * Verbs whose effect is a change to the workspace.
 *
 * The only vocabulary that decides anything, and it is consulted only for the head verb of a
 * directive clause — so one of these words appearing anywhere else in a sentence changes nothing. It
 * errs towards inclusion: a false entry turns a discussion into a task that stops at the confirmation
 * line, while a missing entry turns a real change into a question that answers instead of doing the
 * work.
 */
const MUTATE: readonly string[] = Object.freeze([
  "add", "adjust", "annotate", "append", "apply", "bump", "change", "clean", "cleanup", "commit",
  "convert", "correct", "create", "delete", "deploy", "document", "drop", "edit", "erase", "extract",
  "fix", "format", "generate", "implement", "improve", "inline", "insert", "install", "migrate",
  "make", "modify", "move", "patch", "polish", "publish", "refactor", "remove", "rename", "reorder",
  "replace", "restore", "revert", "rewrite", "scaffold", "set", "simplify", "split", "stage", "swap",
  "tidy", "trim", "undo", "update", "upgrade", "write",
]);

/**
 * The same list as Arabic imperative and second-person verb forms.
 *
 * Verb forms only. The verbal nouns (`حذف` deletion, `تعديل` modification, `كتابة` writing) are how
 * these actions are *named*, so they are deliberately absent.
 */
const MUTATE_ARABIC: readonly string[] = Object.freeze([
  "احذف", "احذفي", "تحذف", "امسح", "امسحي", "تمسح", "عدل", "عدلي", "تعدل", "غير", "غيري", "تغير",
  "أضف", "اضف", "أضيفي", "تضيف", "اكتب", "اكتبي", "تكتب", "أنشئ", "انشئ", "تنشئ", "أصلح", "اصلح",
  "تصلح", "حدث", "حدثي", "تحدث", "انقل", "انقلي", "تنقل", "أعد", "اعد", "تعيد", "استبدل", "استبدلي",
  "تستبدل", "طبق", "طبيقي", "تطبق", "رتب", "رتّب", "نظف", "نظّف",
]);

/**
 * Tokens that make a head verb nominal rather than imperative.
 *
 * "delete of the file", "write mode", "delete attempt" — a verb followed by one of these is a noun in
 * a sentence about the action, not an instruction to perform it.
 */
const NOMINAL_FOLLOWERS: readonly string[] = Object.freeze([
  "of", "is", "are", "was", "were", "mode", "operation", "attempt", "request",
  "failed", "fails", "happened", "happens", "means", "meaning", "blocked", "allowed", "supported",
]);

/** Clauses, so a negation or a frame is judged where it appears rather than across the whole request. */
function clauses(text: string): readonly string[] {
  return Object.freeze(
    text
      .split(/[\n;.•]|(?<=[.!?])\s+|,\s+/i)
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0),
  );
}

/** The clause with quoted spans blanked out: a phrase in quotes is mentioned, not requested. */
function withoutQuotes(clause: string): string {
  return clause
    .replace(/"[^"]*"/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/«[^»]*»/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/'[^']{2,}'/g, " ");
}

/** Words, punctuation dropped, lower-cased, in order. */
function words(text: string): readonly string[] {
  return Object.freeze(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}'\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 0),
  );
}

/**
 * The head verb of a clause, or `null` when it does not lead with one.
 *
 * The head is the first word that is not a lead-in — so a clause opening with `hello`, `the`, `this`,
 * `explain` or `what` has no mutating head, and one opening with `delete` or `احذف` does. A request
 * frame moves the search to just after it, which is what makes "I want you to delete the log" a
 * request rather than a statement about a want.
 */
function headVerb(clause: string): string | null {
  const cleaned = withoutQuotes(clause);
  if (BOUNDING.some((pattern) => pattern.test(cleaned))) return null;
  let search = cleaned;
  for (const frame of REQUEST_FRAMES) {
    const match = frame.exec(cleaned);
    if (match === null) continue;
    search = cleaned.slice(match.index + match[0].length);
    break;
  }
  const parts = words(search);
  let index = 0;
  while (index < parts.length && LEAD_INS.includes(parts[index]!)) index += 1;
  const head = parts[index];
  if (head === undefined) return null;
  // A head that is not a mutating verb is not this kind of directive: "hello after delete" leads with
  // `hello`, and "explain the migration" leads with a verb that asks for an answer.
  if (!MUTATE.includes(head) && !MUTATE_ARABIC.includes(head)) return null;
  const follower = parts[index + 1];
  if (follower !== undefined && NOMINAL_FOLLOWERS.includes(follower)) return null;
  return head;
}

/**
 * Whether the clause asks a question rather than giving an instruction.
 *
 * A question can still be a request — "can you delete the file?" — which is why the frame test comes
 * first and a framed clause is never treated as a question.
 */
function isQuestion(clause: string): boolean {
  const cleaned = withoutQuotes(clause).trim();
  if (WH_START.test(cleaned)) return true;
  if (/\?\s*$/.test(cleaned)) return !FRAMED_START.test(cleaned) && !REQUEST_FRAMES.some((pattern) => pattern.test(cleaned.slice(0, 24)));
  if (AUX_START.test(cleaned)) return !FRAMED_START.test(cleaned);
  return false;
}

/**
 * The requested effect: a change to the workspace, or an answer about it.
 *
 * Deterministic and cheap: no model, no history, no scoring. Everything the operator can do is behind
 * a confirmation that names this mode, so the cost of being wrong is a visible line and an `n` — but
 * the two directions are not equally bad, which is why a directive with a mutating head is a write
 * even when it is phrased politely, and a sentence that merely mentions a change is not.
 */
export function classifyRequestIntent(text: string): RequestIntent {
  for (const clause of clauses(text)) {
    if (isQuestion(clause)) continue;
    if (headVerb(clause) === null) continue;
    return "write";
  }
  return "read";
}
