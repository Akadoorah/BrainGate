import test from "node:test";
import assert from "node:assert/strict";
import { BrainGateInvariantError } from "./errors.js";
import { BudgetTracker, budgetFor } from "./budget.js";
import { classifyTask, type TaskClassification } from "./classifier.js";

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

// Truncating at a turn limit does not buy half an answer for half the price: the run ends with
// no result and every turn already spent is wasted. So these are ceilings on pathology, and a
// simple lookup in a real repository must fit inside the smallest of them.
test("even the smallest tier allows enough turns for real exploration", () => {
  const smallest = budgetFor(classifyTask({ text: "Where is the paywall logic implemented?", mode: "ask" }), { writeRequested: false });
  assert.ok(smallest.maxInspectionTurns >= 12, `a lookup got ${String(smallest.maxInspectionTurns)} turns, which a real repository does not fit inside`);
  assert.ok(smallest.maxInspectionMs >= 120_000);
});

/** A classification of a given tier, without inventing the shape the classifier produces. */
function atTier(complexity: "T0" | "T1" | "T2" | "T3" | "T4"): TaskClassification {
  return { ...classifyTask({ text: "any task", mode: "ask" }), complexity };
}

test("the ceilings widen with complexity and never narrow", () => {
  const order = ["T0", "T1", "T2", "T3", "T4"] as const;
  const budgets = order.map((complexity) => budgetFor(atTier(complexity), { writeRequested: false }));
  for (let index = 1; index < budgets.length; index += 1) {
    assert.ok(budgets[index]!.maxInspectionTurns >= budgets[index - 1]!.maxInspectionTurns, `${order[index]!} allows fewer turns than ${order[index - 1]!}`);
    assert.ok(budgets[index]!.maxInspectionMs >= budgets[index - 1]!.maxInspectionMs, `${order[index]!} allows less time than ${order[index - 1]!}`);
  }
});
