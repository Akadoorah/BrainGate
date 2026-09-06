import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError } from "./errors.js";
import { BudgetTracker, budgetFor } from "./budget.js";
import { classifyTask } from "./classifier.js";

test("tiny tasks permit one provider call and no council", () => {
  const classification = classifyTask({ text: "وين ملف اللوجو؟", mode: "ask" });
  const budget = budgetFor(classification, { writeRequested: false });
  assert.equal(budget.maxProviderCalls, 1);
  assert.equal(budget.councilPolicy, "disabled");
  assert.equal(budget.maxReviewers, 0);
});

test("provider call and context caps fail closed", () => {
  const classification = classifyTask({ text: "Add a settings page", mode: "write" });
  const budget = budgetFor(classification, { writeRequested: true });
  const tracker = new BudgetTracker(budget);

  tracker.reserveProviderCall({ contextTokens: 20_000 });
  tracker.reserveProviderCall({ reviewer: true, contextTokens: 20_000 });
  assert.throws(
    () => tracker.reserveProviderCall(),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "BUDGET_PROVIDER_CALLS_EXCEEDED",
  );
  assert.throws(
    () => new BudgetTracker(budget).reserveProviderCall({ contextTokens: budget.maxContextTokens + 1 }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "BUDGET_CONTEXT_EXCEEDED",
  );
});

test("concurrency cap is hard", () => {
  const classification = classifyTask({ text: "Add a settings page", mode: "write" });
  const tracker = new BudgetTracker(budgetFor(classification, { writeRequested: true }));
  const release = tracker.beginAgent();
  assert.throws(
    () => tracker.beginAgent(),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "BUDGET_CONCURRENCY_EXCEEDED",
  );
  release();
  const releaseAgain = tracker.beginAgent();
  releaseAgain();
});

test("critical writes require approval and bounded disagreement council", () => {
  const classification = classifyTask({ text: "غير نظام الدفع والاشتراكات", mode: "write" });
  const budget = budgetFor(classification, { writeRequested: true });
  assert.equal(budget.reviewerPolicy, "required");
  assert.equal(budget.maxReviewers, 2);
  assert.equal(budget.councilPolicy, "disagreement-only");
  assert.equal(budget.humanApprovalBeforeWrite, true);

  const tracker = new BudgetTracker(budget);
  assert.throws(
    () => tracker.assertWriteApproval(false),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "BUDGET_HUMAN_APPROVAL_REQUIRED",
  );
  tracker.assertWriteApproval(true);
  tracker.recordCouncilRound();
  assert.throws(
    () => tracker.recordCouncilRound(),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "BUDGET_COUNCIL_EXCEEDED",
  );
});

test("repair and retry loops cannot exceed policy", () => {
  const classification = classifyTask({ text: "Fix a normal UI bug", mode: "write" });
  const budget = budgetFor(classification, { writeRequested: true });
  const tracker = new BudgetTracker(budget);
  tracker.recordRepairRound();
  assert.throws(() => tracker.recordRepairRound(), /repair rounds/);
  tracker.recordAutomaticRetry();
  assert.throws(() => tracker.recordAutomaticRetry(), /automatic retries/);
});
