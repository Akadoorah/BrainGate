import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask, reclassifyTask } from "./classifier.js";
import { budgetFor } from "./budget.js";

test("tiny Arabic question stays cheap", () => {
  const result = classifyTask({ text: "وين ملف اللوجو؟", mode: "ask" });
  assert.equal(result.complexity, "T0");
  assert.equal(result.risk, "low");
  assert.equal(result.requiresScout, false);
});

test("ordinary write becomes T2 without raising risk", () => {
  const result = classifyTask({ text: "Add a settings page", mode: "write" });
  assert.equal(result.complexity, "T2");
  assert.equal(result.risk, "low");
  assert.equal(result.requiresScout, true);
});

test("Arabic payment write becomes critical T4", () => {
  const result = classifyTask({ text: "غير نظام الدفع والاشتراكات حتى ما يصير خصم مرتين", mode: "write" });
  assert.equal(result.complexity, "T4");
  assert.equal(result.risk, "critical");
  assert.ok(result.sensitiveDomains.includes("payments"));
});

test("auth question is treated as high risk even when phrased as a question", () => {
  const result = classifyTask({ text: "ليش تسجيل الدخول أحيانا يطلع المستخدم؟", mode: "ask" });
  assert.equal(result.complexity, "T3");
  assert.equal(result.risk, "high");
  assert.ok(result.sensitiveDomains.includes("auth"));
});

test("inspection escalates hidden impact", () => {
  const initial = classifyTask({ text: "Rename this field", mode: "write" });
  assert.equal(initial.complexity, "T2");
  const inspected = reclassifyTask(initial, {
    text: "Rename this field",
    mode: "write",
    inspection: { affectedFiles: 22, publicApi: true },
  });
  assert.equal(inspected.complexity, "T3");
});

test("confirmed simple cause can de-escalate a generic bug", () => {
  const initial = classifyTask({ text: "I have a weird bug and it is broken", mode: "ask" });
  assert.equal(initial.complexity, "T2");
  const inspected = reclassifyTask(initial, {
    text: "I have a weird bug and it is broken",
    mode: "ask",
    inspection: { affectedFiles: 1, simpleCauseConfirmed: true },
  });
  assert.equal(inspected.complexity, "T1");
  assert.equal(inspected.risk, "low");
});

test("high risk stays sticky and restores its complexity floor", () => {
  const initial = classifyTask({ text: "Review auth token handling", mode: "review" });
  assert.equal(initial.risk, "high");
  const next = reclassifyTask(initial, {
    text: "Review this helper",
    mode: "review",
    inspection: { affectedFiles: 1, simpleCauseConfirmed: true },
  });
  assert.equal(next.risk, "high");
  assert.equal(next.complexity, "T3");
});

test("cross-repo impact reaches T4", () => {
  const result = classifyTask({ text: "Update shared user model", mode: "write", inspection: { crossRepo: true } });
  assert.equal(result.complexity, "T4");
});

// A whole-application review was classified below "where is X implemented", so it received a
// lookup's turn budget and died with error_max_turns before reaching an answer. Breadth is a
// cost driver on its own: answering broadly means reading widely, whatever the risk.
test("a question that ranges over the codebase outranks one that points at a place in it", () => {
  const broad = classifyTask({ text: "Review the paywall approach across the whole application", mode: "ask" });
  const narrow = classifyTask({ text: "Where is the paywall logic implemented?", mode: "ask" });
  const order = ["T0", "T1", "T2", "T3", "T4"];
  assert.ok(
    order.indexOf(broad.complexity) > order.indexOf(narrow.complexity),
    `breadth must outrank a lookup: ${broad.complexity} vs ${narrow.complexity}`,
  );
  assert.ok(budgetFor(broad, { writeRequested: false }).maxInspectionTurns > budgetFor(narrow, { writeRequested: false }).maxInspectionTurns);
});

test("an open-ended judgement is recognised in either language", () => {
  // The Arabic original that failed, and its English equivalent: the cue is the shape of the
  // question, not the language it is asked in.
  for (const text of ["ما رأيك بـ Paywalls عامة في التطبيق؟", "What do you think about paywalls generally in the app?"]) {
    const classification = classifyTask({ text, mode: "ask" });
    assert.equal(classification.complexity, "T3", `expected T3 for: ${text}`);
    assert.ok(classification.reasons.includes("open-ended-judgement"), `missing the judgement cue for: ${text}`);
  }
});

test("breadth raises complexity without inventing risk", () => {
  // Reading widely is expensive, not dangerous. Inflating risk would pull in a reviewer and
  // double the cost of an ordinary question.
  assert.equal(classifyTask({ text: "What do you think about the caching approach generally?", mode: "ask" }).risk, "low");
});

test("an ordinary lookup is not inflated by the breadth signal", () => {
  for (const text of ["Where is the theme configuration defined?", "وين معرّف إعداد الثيم؟", "What Node version does this need?"]) {
    const classification = classifyTask({ text, mode: "ask" });
    assert.ok(["T0", "T1"].includes(classification.complexity), `${text} became ${classification.complexity}`);
  }
});
