import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask, reclassifyTask } from "./classifier.js";

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
