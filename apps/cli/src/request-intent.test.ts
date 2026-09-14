import test from "node:test";
import assert from "node:assert/strict";
import { classifyRequestIntent } from "./request-intent.js";

/**
 * Intent is the requested effect, not the absence of constraints.
 *
 * Real dogfood classified "Apply the agreed harmless comment-only change … do not commit, do not
 * create a branch, do not use git reset" as a read twice, because the old rule looked for a write
 * verb at the *start* of the request and did not know the word "apply". The read classification then
 * handed the write to a native session created under a standing "do not modify files" instruction,
 * which refused it. These are the adversarial cases that make that class of bug go away.
 */

// ---------------------------------------------------------------- write, with constraints

test("A: a write with a constraint is still a write", () => {
  assert.equal(classifyRequestIntent("Apply this fix, but do not commit."), "write");
  assert.equal(classifyRequestIntent("Change only README.md and do not touch anything else."), "write");
  assert.equal(classifyRequestIntent("Implement it without creating a branch."), "write");
  assert.equal(classifyRequestIntent("Append this comment, but do not run git commands."), "write");
  assert.equal(classifyRequestIntent("Fix the bug and leave the changes uncommitted."), "write");
});

test("A: the dogfood request, verbatim, is a write", () => {
  const request = [
    "Apply the agreed harmless comment-only change to the selected README file.",
    "Modify only that file, do not commit, do not create a branch,",
    "do not use git reset, do not use git clean, do not use git stash, do not use git checkout,",
    "and report exactly which file changed.",
  ].join("\n");
  assert.equal(classifyRequestIntent(request), "write");
});

test("a multiline write request with a numbered constraint list is a write", () => {
  const request = [
    "Apply the harmless comment-only change we agreed on to the selected README file.",
    "",
    "This is a disposable test workspace.",
    "",
    "Requirements:",
    "- modify only that one file;",
    "- do not commit;",
    "- do not create a branch;",
    "- report exactly which file changed.",
  ].join("\n");
  assert.equal(classifyRequestIntent(request), "write");
});

test("a write verb after a qualifier is still a write", () => {
  assert.equal(classifyRequestIntent("Now apply the change you proposed."), "write");
  assert.equal(classifyRequestIntent("Please add the missing import."), "write");
  assert.equal(classifyRequestIntent("Go ahead and update the config value."), "write");
  assert.equal(classifyRequestIntent("Also rename that variable while you are there."), "write");
});

test("a constraint before the effect does not cancel it", () => {
  assert.equal(classifyRequestIntent("Without touching the config, add the flag to the CLI."), "write");
  assert.equal(classifyRequestIntent("Do not commit anything, just make the edit."), "write");
});

// ---------------------------------------------------------------- read

test("a review that forbids modification is a read", () => {
  assert.equal(classifyRequestIntent("Review this; do not modify anything."), "read");
  assert.equal(classifyRequestIntent("Inspect this file and do not modify anything."), "read");
  assert.equal(classifyRequestIntent("Inspect this repository and identify one small file.\n\nDo not modify anything yet."), "read");
  assert.equal(classifyRequestIntent("Review the previous worker's recommendation.\n\nDo not modify files."), "read");
});

test("a question about how something would be done is a read", () => {
  assert.equal(classifyRequestIntent("Tell me how you would implement the fix."), "read");
  assert.equal(classifyRequestIntent("Explain what would need to change."), "read");
  assert.equal(classifyRequestIntent("Inspect the current implementation."), "read");
  assert.equal(classifyRequestIntent("Where is the paywall logic implemented?"), "read");
  assert.equal(classifyRequestIntent("What would you change about this design?"), "read");
  assert.equal(classifyRequestIntent("How would you fix the login bug?"), "read");
});

test("the read turns of the dogfood session are reads", () => {
  assert.equal(classifyRequestIntent("Tell me what you originally recommended and what Haiku verified while you were away. Do not modify files."), "read");
  assert.equal(classifyRequestIntent("what does the theme configuration do when the session expires?"), "read");
});

test("a request with no verb of either kind is a read", () => {
  assert.equal(classifyRequestIntent("the splash screen and the auth initial state"), "read");
  assert.equal(classifyRequestIntent(""), "read");
});

test("asking whether something can be done is a request", () => {
  assert.equal(classifyRequestIntent("Can you apply the fix?"), "write");
  assert.equal(classifyRequestIntent("Could you add a comment to the README?"), "write");
});

test("a question about which file to change is a read", () => {
  assert.equal(classifyRequestIntent("Which file in this repository is safest to change for a reversible test?"), "read");
  assert.equal(classifyRequestIntent("What should I update to make the banner shorter?"), "read");
  assert.equal(classifyRequestIntent("Which files would I need to edit?"), "read");
  // And the same words as an instruction are still a write.
  assert.equal(classifyRequestIntent("Change the banner text in README.md."), "write");
  assert.equal(classifyRequestIntent("Which file is safest to change? Now change it."), "write");
});

test("a noun that happens to be a write verb does not make a read a write", () => {
  // "comment" is a verb in a wiki and a noun in every code review. These are reads.
  assert.equal(classifyRequestIntent("Read that README from disk and confirm the comment is there."), "read");
  assert.equal(classifyRequestIntent("Is the comment in the file the same as the one you proposed?"), "read");
  // And asking for one is still a write.
  assert.equal(classifyRequestIntent("Append a comment line to the README."), "write");
});

// ---------------------------------------------------------------- the adversarial matrix

/**
 * The failure that produced this architecture, and everything like it.
 *
 * The rule the matrix tests is not "these sentences are reads" but "these *shapes* are reads": a
 * question, a statement, a negation, a hypothesis, a quotation, or a sentence whose head word is not
 * a verb. Every entry on the right is the same vocabulary used as a request. A classifier built from
 * keywords cannot separate the two columns; one built from directive structure and requested effect
 * separates them without knowing which words are dangerous.
 */
const NON_WRITES: readonly string[] = [
  // The reported failure, and its neighbours.
  "hello after delete",
  "hello",
  "thanks, that worked",
  // Questions *about* the vocabulary.
  "what does delete mean?",
  "explain how write mode works",
  "explain the payment migration",
  "describe the auth flow",
  "which files did the write touch?",
  "tell me about the checkout flow",
  "how does the security configuration work",
  "what happened to the cancelled write attempt?",
  // Quoted, negated and hypothetical mentions.
  'why was "remove auth middleware" blocked?',
  "explain 'delete README.md'",
  "do not delete or modify anything",
  "don't run the migration yet",
  "what would happen if we removed the auth middleware?",
  // Statements, descriptions and reports.
  "read this file and tell me whether it deletes anything",
  "summarize the security migration",
  "state which provider wrote marker 2",
  "I see the auth middleware was removed",
  "the payment migration is described in docs/payments.md",
  "the delete failed earlier",
  "no changes needed",
  "nothing to do here",
  "is the migration safe?",
  "removing auth is blocked, right?",
  // Arabic: questions about the actions, and negations.
  "شو يعني حذف الملف؟",
  "اشرح لي نظام الدفع والمصادقة بدون تعديل شيء",
  'لماذا طلب "احذف الملف" يعتبر خطير؟',
  "لماذا لا يمكن حذف الملف؟",
  "ما معنى تعديل نظام الدفع؟",
  "هل يمكن حذف هذا الملف؟",
  "شو صار بالـ write attempt الملغى؟",
  "هل هذا الملف آمن للتعديل؟",
  "أريد أن أعرف كيف يعمل نظام الدفع",
  "مرحبا بعد الحذف",
];

const WRITES: readonly string[] = [
  // The examples the acceptance named.
  "delete README.md",
  "remove the auth middleware",
  "modify the payment migration",
  "update the security configuration",
  "append this line to the file",
  "احذف هذا الملف",
  "عدل نظام المصادقة",
  "غير ملف الدفع",
  // Politeness is not a read.
  "please delete the temporary file",
  "can you delete the log file?",
  "I want you to remove the dead code",
  "من فضلك احذف الملف المؤقت",
  "ممكن تعدل ملف الدفع؟",
  "أضف سطر تعليق إلى الملف",
  // The session's own write requests, verbatim.
  "Apply the agreed harmless comment-only change to the selected README file:",
  "Append one inert comment line:",
  "Add a second comment line in the same style.",
  "change the empty-state label to Nothing yet",
  "Write the marker into docs/notes.md",
  "rename the helper to something clearer",
  "fix the typo in the README",
  // A qualifier or a constraint before the verb does not cancel it.
  "Now apply the change you proposed.",
  "Also rename that variable while you are there.",
  "Go ahead and update the config value.",
  "Without touching the config, add the flag to the CLI.",
  "Do not commit anything, just make the edit.",
  "Which file is safest to change? Now change it.",
];

test("the adversarial matrix: effect decides, vocabulary does not", () => {
  for (const prompt of NON_WRITES) {
    assert.equal(classifyRequestIntent(prompt), "read", `should be a read: ${prompt}`);
  }
  for (const prompt of WRITES) {
    assert.equal(classifyRequestIntent(prompt), "write", `should be a write: ${prompt}`);
  }
});

test("long, multiline and mixed prompts are judged by their directive clauses", () => {
  const long = [
    "Here is the context you asked for.",
    "The payment migration touched the checkout path, and the auth middleware was removed last week.",
    "Do not modify anything: this is background.",
    "",
    "Please summarize what changed.",
  ].join("\n");
  assert.equal(classifyRequestIntent(long), "read", "a long explanation with an observe directive is a read");

  const longWrite = [
    "Here is the context you asked for.",
    "The payment migration touched the checkout path.",
    "",
    "Append one line to docs/notes.md and do not touch anything else.",
  ].join("\n");
  assert.equal(classifyRequestIntent(longWrite), "write", "and the same shape with a mutating directive is a write");

  const mixed = "اشرح لي ما حدث في الدفع.\n\nاحذف الملف المؤقت بعد ذلك.";
  assert.equal(classifyRequestIntent(mixed), "write", "the Arabic directive decides, whatever precedes it");
});
