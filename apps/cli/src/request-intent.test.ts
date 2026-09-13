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
