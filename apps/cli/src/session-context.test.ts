import test from "node:test";
import assert from "node:assert/strict";
import { SessionContext } from "./session-context.js";

test("a follow-up can see what was already asked and answered", () => {
  const session = new SessionContext();
  session.record("which modules send email?", "email.service.ts and the broadcast worker.");
  const turns = session.recent(48_000);
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.request, /which modules send email/);
  assert.match(turns[0]!.answer, /broadcast worker/);
});

test("the thread is bounded by the task's context budget, dropping oldest first", () => {
  const session = new SessionContext();
  for (let index = 0; index < 6; index += 1) {
    session.record(`question number ${String(index)}`, "a long answer. ".repeat(60));
  }
  const small = session.recent(1_200);
  const large = session.recent(160_000);

  assert.ok(small.length < large.length, "a smaller budget must carry fewer turns");
  assert.ok(small.length >= 1, "at least the most recent turn should survive");
  // The nearest turn is what a follow-up usually refers to, so it is the one kept.
  assert.match(small.at(-1)!.request, /question number 5/);
});

test("a long session does not grow without bound", () => {
  const session = new SessionContext();
  for (let index = 0; index < 50; index += 1) session.record(`q${String(index)}`, `a${String(index)}`);
  assert.ok(session.size <= 6, `expected the thread to be capped, got ${String(session.size)}`);
  assert.match(session.recent(160_000).at(-1)!.request, /q49/);
});

test("/forget drops the thread", () => {
  const session = new SessionContext();
  session.record("something", "an answer");
  session.clear();
  assert.equal(session.size, 0);
  assert.deepEqual(session.recent(48_000), []);
});

test("empty exchanges are not recorded", () => {
  const session = new SessionContext();
  session.record("   ", "an answer");
  session.record("a question", "   ");
  assert.equal(session.size, 0);
});

test("a very long answer is truncated rather than carried whole", () => {
  const session = new SessionContext();
  session.record("explain everything", "x".repeat(10_000));
  const answer = session.recent(160_000)[0]!.answer;
  assert.ok(answer.length < 2_000, "a session carries the thread of the conversation, not its transcript");
  assert.match(answer, /…$/);
});
