import test from "node:test";
import assert from "node:assert/strict";
import { taskTitleFor } from "./index.js";

// A task recorded as "Dogfood ask T0" made BrainGate's own history unreadable: it could say
// which models ran and what they cost, but not what was asked.
test("a task is named by the request, normalised and bounded", () => {
  assert.equal(taskTitleFor("where is the authentication logic?"), "where is the authentication logic?");
  // A pasted multi-line request becomes one line, so a list stays a list.
  assert.equal(taskTitleFor("  fix   the\n\tlogin  bug "), "fix the login bug");
  assert.equal(taskTitleFor("   "), "Untitled task");
});

test("a long request is cut between words, and says that it was cut", () => {
  const long = taskTitleFor(`${"alpha beta ".repeat(40)}omega`);
  assert.ok(long.length <= 121, `title grew to ${String(long.length)}`);
  assert.ok(long.endsWith("…"));
  assert.doesNotMatch(long, /alph…$/, "the cut must land between words, not mid-word");
});

test("a secret pasted into a request never becomes the ledger's copy of it", () => {
  // The title is stored and shown back. A request carrying a key must not turn the history into
  // the place that key now lives — which is why this helper sits next to redaction rather than
  // leaving each call site to remember.
  const title = taskTitleFor("check why ghp_abcdefghijklmnopqrstuvwxyz0123 stopped working");
  assert.doesNotMatch(title, /ghp_abcdefghijklmnopqrstuvwxyz0123/);
  assert.match(title, /REDACTED/);
});
