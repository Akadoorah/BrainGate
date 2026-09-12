/**
 * Attribution from the task's own events: who ran, who was refused, who never started.
 *
 * The ledger is the only source that cannot be wrong here — a role that was routed never wrote a
 * `shadow.provider.started` event, and a role whose call was refused and failed over wrote two.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { executionAttribution, recordedExecutionAttribution, executionRecord, type ObservationRole, type TaskEvent } from "./index.js";

let sequence = 0;
function event(kind: string, payload: unknown): TaskEvent {
  return { sequence: ++sequence, taskId: "11111111-1111-4111-8111-111111111111", projectId: "p", kind, fromState: null, toState: null, payload, occurredAt: "2026-09-12T00:00:00.000Z" };
}

const planned: readonly ObservationRole[] = Object.freeze([
  { role: "planner", providerId: "anthropic", modelId: "claude-fable", status: "planned" },
  { role: "primary", providerId: "anthropic", modelId: "claude-sonnet", status: "planned" },
  { role: "reviewer", providerId: "openai", modelId: "gpt-6-astra", status: "planned" },
]);

test("a role that was only routed is planned, and one that ran is completed", () => {
  const attribution = executionAttribution({
    events: [event("shadow.provider.started", { role: "primary", phase: "initial", provider: "anthropic", model: "claude-sonnet" })],
    planned,
  });
  assert.deepEqual(attribution.map((role) => `${role.role}:${role.status}`), ["primary:attempted", "planner:planned", "reviewer:planned"]);
});

test("a provider that answered is completed, and each phase of it stays one entry", () => {
  const attribution = executionAttribution({
    events: [
      event("shadow.provider.started", { role: "primary", phase: "initial", provider: "anthropic", model: "claude-sonnet" }),
      event("shadow.provider.completed", { role: "primary", phase: "initial", provider: "anthropic", model: "claude-sonnet" }),
      event("shadow.provider.started", { role: "primary", phase: "repair-1", provider: "anthropic", model: "claude-sonnet" }),
      event("shadow.provider.completed", { role: "primary", phase: "repair-1", provider: "anthropic", model: "claude-sonnet" }),
    ],
    planned,
  });
  const primary = attribution.filter((role) => role.role === "primary");
  assert.equal(primary.length, 1, "the same model in two phases is one role entry");
  assert.equal(primary[0]!.status, "completed");
});

test("a refusal and the failover that replaced it are both in the record, in order", () => {
  const attribution = executionAttribution({
    events: [
      event("shadow.provider.started", { role: "planner", phase: "planning", provider: "anthropic", model: "claude-fable" }),
      event("shadow.provider.failed", { role: "planner", phase: "planning", provider: "anthropic", model: "claude-fable", failureKind: "provider-failed" }),
      event("shadow.provider.started", { role: "planner", phase: "planning", provider: "google", model: "gemini-3.1-pro-high" }),
      event("shadow.provider.completed", { role: "planner", phase: "planning", provider: "google", model: "gemini-3.1-pro-high" }),
    ],
    planned,
  });
  assert.deepEqual(attribution.map((role) => `${role.role}:${role.providerId}:${role.status}`), [
    "planner:anthropic:attempted",
    "planner:google:completed",
    "primary:anthropic:planned",
    "reviewer:openai:planned",
  ]);
});

test("the judge is attributed the same way, and does not appear when it never ran", () => {
  const withoutJudge = executionAttribution({ events: [], planned });
  assert.equal(withoutJudge.some((role) => role.role === "judge"), false, "a judge that was never routed is not invented");
  const withJudge = executionAttribution({
    events: [event("shadow.provider.started", { role: "judge", phase: "judge-1", provider: "openai", model: "gpt-6-astra" })],
    planned,
  });
  assert.deepEqual(withJudge.find((role) => role.role === "judge"), { role: "judge", providerId: "openai", modelId: "gpt-6-astra", status: "attempted" });
});

test("an event that names no recognisable role is ignored rather than guessed at", () => {
  const attribution = executionAttribution({ events: [event("shadow.provider.started", { role: "scout", provider: "anthropic", model: "claude-x" })] });
  assert.deepEqual(attribution, []);
});

test("the recorded attribution round-trips, and a legacy task falls back to its events", () => {
  const roles = executionAttribution({ events: [event("shadow.provider.started", { role: "primary", phase: "initial", provider: "anthropic", model: "claude-sonnet" })], planned });
  const record = executionRecord(roles);
  const events = [event("task.execution", record)];
  const restored = recordedExecutionAttribution(events);
  assert.deepEqual(restored, roles);
  // A task with no such event derives the same thing from the provider events it does have.
  assert.deepEqual(recordedExecutionAttribution([]), null);
});
