import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionContext, sessionThreadPath } from "./session-context.js";

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

test("a thread outlives the process, and comes back to the same project", () => {
  const home = mkdtempSync(join(tmpdir(), "braingate-thread-"));
  const path = sessionThreadPath(home);

  const first = new SessionContext({ path });
  first.record("where is the logo?", "in assets/logo.svg");
  assert.equal(first.resumed, 0, "a new thread resumes nothing");

  const second = new SessionContext({ path });
  assert.equal(second.resumed, 1);
  assert.deepEqual([...second.recent(24_000)], [{ request: "where is the logo?", answer: "in assets/logo.svg" }]);

  // A different project has its own file and cannot see this one.
  const elsewhere = new SessionContext({ path: sessionThreadPath(mkdtempSync(join(tmpdir(), "braingate-thread-other-"))) });
  assert.equal(elsewhere.size, 0);
});

test("a thread old enough to have changed subject is not resumed", () => {
  const path = sessionThreadPath(mkdtempSync(join(tmpdir(), "braingate-thread-age-")));
  let clock = Date.parse("2026-09-10T09:00:00.000Z");
  new SessionContext({ path, now: () => clock }).record("what does the parser do?", "it reads NDJSON");

  clock += 7 * 60 * 60 * 1000;
  assert.equal(new SessionContext({ path, now: () => clock }).resumed, 1, "a few hours later is still the same thread");

  clock += 2 * 60 * 60 * 1000;
  assert.equal(new SessionContext({ path, now: () => clock }).resumed, 0, "the next day is not");
});

test("a secret in an answer never reaches the file", () => {
  const path = sessionThreadPath(mkdtempSync(join(tmpdir(), "braingate-thread-secret-")));
  const session = new SessionContext({ path });
  session.record("what is the key?", "the token is sk-abcdefghijklmnopqrstuvwxyz012345");
  const written = readFileSync(path, "utf8");
  assert.doesNotMatch(written, /sk-abcdefghijklmnopqrstuvwxyz012345/, "a thread that outlives the process is where a secret would settle");
});

test("forget deletes the thread rather than only forgetting it here", () => {
  const path = sessionThreadPath(mkdtempSync(join(tmpdir(), "braingate-thread-forget-")));
  const session = new SessionContext({ path });
  session.record("a", "b");
  session.clear();
  assert.equal(existsSync(path), false);
  assert.equal(new SessionContext({ path }).size, 0);
});

test("an unreadable thread starts a fresh session rather than failing one", () => {
  const path = sessionThreadPath(mkdtempSync(join(tmpdir(), "braingate-thread-broken-")));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{not json", "utf8");
  assert.equal(new SessionContext({ path }).size, 0);
});
