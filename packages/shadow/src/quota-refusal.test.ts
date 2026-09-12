/**
 * Recognising a real quota refusal, and refusing to invent one.
 *
 * The fixture strings are the shapes measured on 2026-09-12 against an exhausted Claude
 * subscription (Claude Code 2.1.268): a stream line carrying `error: rate_limit`, and a result
 * envelope carrying `api_error_status: 429` with the reset stated only as localized prose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { providerQuotaRefusal, quotaReadings } from "./quota-readings.js";
import { SubscriptionShadowAgentInvoker } from "./invoker.js";

const STREAM_REFUSAL = JSON.stringify({
  type: "assistant",
  is_api_error_message: true,
  error: "rate_limit",
  content: [{ type: "text", text: "You've hit your session limit · resets 4:10am (Europe/Istanbul)" }],
  session_id: "7acd83f4",
});

const RESULT_REFUSAL = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  num_turns: 1,
  api_error_status: 429,
  terminal_reason: "api_error",
  duration_ms: 1183,
  result: "You've hit your session limit · resets 4:10am (Europe/Istanbul)",
});

test("the real 429/rate_limit refusal shape is recognised as native quota evidence", () => {
  const refusal = providerQuotaRefusal("anthropic", "claude-subscription", `${STREAM_REFUSAL}\n${RESULT_REFUSAL}`, new Date("2026-09-12T00:24:33.000Z"));
  assert.ok(refusal, "the measured refusal must be recognised");
  assert.equal(refusal.providerId, "anthropic");
  assert.equal(refusal.quotaPool, "claude-subscription");
  assert.equal(refusal.reason, "rate_limit");
  assert.equal(refusal.evidence, "native");
  assert.equal(refusal.observedAt, "2026-09-12T00:24:33.000Z");
  // The provider's own sentence is kept as evidence, including the phrase BrainGate refuses to parse.
  assert.match(refusal.detail, /resets 4:10am \(Europe\/Istanbul\)/);
});

test("localized reset prose is never turned into a reset time", () => {
  const refusal = providerQuotaRefusal("anthropic", "claude-subscription", `${STREAM_REFUSAL}\n${RESULT_REFUSAL}`);
  assert.ok(refusal);
  assert.equal(refusal.resetAt, null, "a phrase is not an instant; guessing one is how a refusal becomes a verdict");
  // And nothing about the record claims a window: no utilization, no window name, no decay.
  assert.deepEqual(Object.keys(refusal).sort(), ["detail", "evidence", "observedAt", "providerId", "quotaPool", "reason", "resetAt"]);
});

test("a machine-readable reset is carried when the provider actually states one", () => {
  const withReset = JSON.stringify({ type: "result", api_error_status: 429, terminal_reason: "api_error", resetsAt: 1_787_000_000 });
  const refusal = providerQuotaRefusal("anthropic", "claude-subscription", withReset);
  assert.ok(refusal);
  assert.equal(refusal.resetAt, new Date(1_787_000_000 * 1000).toISOString());
});

test("failures that are not quota statements are not treated as refusals", () => {
  // A generic non-zero exit with prose.
  assert.equal(providerQuotaRefusal("anthropic", "claude-subscription", "Error: connection reset by peer"), null);
  // A sandbox that did not apply.
  assert.equal(providerQuotaRefusal("xai", "grok-subscription", JSON.stringify({ type: "result", error: "sandbox_not_applied" })), null);
  // Auth failure.
  assert.equal(providerQuotaRefusal("anthropic", "claude-subscription", JSON.stringify({ is_api_error_message: true, error: "authentication_error" })), null);
  // A 429 without the terminal reason or the api-error marker is not enough on its own.
  assert.equal(providerQuotaRefusal("anthropic", "claude-subscription", JSON.stringify({ api_error_status: 429 })), null);
  // The stream marker alone is: the provider said "rate_limit" about this call.
  assert.ok(providerQuotaRefusal("anthropic", "claude-subscription", STREAM_REFUSAL));
});

test("a refusal is not a utilization reading, so it cannot move routing state", () => {
  // The same output yields no reading: the quota store has nothing to persist as available/limited.
  assert.deepEqual(quotaReadings("anthropic", `${STREAM_REFUSAL}\n${RESULT_REFUSAL}`), []);
  // A rate_limit_event that *does* carry a machine-readable reset still produces a reading, as before.
  const event = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1_787_000_000 } } } });
  const readings = quotaReadings("anthropic", event);
  assert.equal(readings.length, 1);
  assert.equal(readings[0]!.blocked, true);
  assert.equal(readings[0]!.resetAt, new Date(1_787_000_000 * 1000).toISOString());
});

test("a refused attempt writes one failure event, not a second generic one", async () => {
  // The record has to show every attempt once. A failure that is already named (with the provider's
  // own refusal attached) must not be followed by a vaguer duplicate for the same attempt — that is
  // how a single refusal starts reading like two failures.
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ProjectRegistry, TaskLedger, parseProjectConfig } = await import("@braingate/core");
  const root = mkdtempSync(join(tmpdir(), "braingate-refusal-"));
  // The registry requires the repository to exist on disk.
  mkdirSync(join(root, "repo"), { recursive: true });
  const registry = new ProjectRegistry(join(root, "brain"));
  const project = registry.register(parseProjectConfig({ project_id: "refusal-test", name: "Refusal Test", repositories: [join(root, "repo")] }));
  const ledger = new TaskLedger(project);
  ledger.createTask({ title: "refused", complexity: "T2", risk: "low" });
  const taskId = ledger.listTasks()[0]!.taskId;
  class RefusingExecutor {
    async run(): Promise<{ spawned: boolean; exitCode: number; stdout: string; stdoutTail: string; stderr: string; timedOut: boolean; durationMs: number; removedEnvironmentKeys: never[] }> {
      return { spawned: true, exitCode: 1, stdout: `${STREAM_REFUSAL}\n${RESULT_REFUSAL}`, stdoutTail: "", stderr: "", timedOut: false, durationMs: 3, removedEnvironmentKeys: [] };
    }
  }
  const invoker = new SubscriptionShadowAgentInvoker({
    project, cwd: root, snapshots: [snapshotFor("anthropic")], context: {},
    executor: new RefusingExecutor() as never, ledger, taskId,
  });
  await assert.rejects(() => invoker.invoke({ role: "primary", model: { providerId: "anthropic", modelId: "claude-haiku-4-5", quotaPool: "claude-subscription" }, phase: "initial", task: "t", findings: [], candidateOutput: null }));
  const receipt = ledger.receipt(taskId);
  const failures = receipt.events.filter((event) => event.kind === "shadow.provider.failed");
  assert.equal(failures.length, 1, "one attempt, one failure event");
  const refused = receipt.events.filter((event) => event.kind === "shadow.provider.quota_refused");
  assert.equal(refused.length, 1, "and the refusal is named once, separately");
  ledger.close();
});

/** The provider snapshot the invoker needs, with Anthropic available. */
function snapshotFor(providerId: "anthropic") {
  const observedAt = "2026-09-12T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId, displayName: providerId, binary: "claude",
    available: obs(true), version: obs("2.1.268 (Claude Code)"), authState: obs("authenticated" as const), authMode: obs("subscription" as const),
    models: { value: null, evidence: "unknown" as const, sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: false }),
    usage: { value: null, evidence: "unknown" as const, sourceCommand: null, observedAt },
    removedBillingOverrides: [], warnings: [],
  };
}

/**
 * The negatives. A quota refusal is a narrow, positively-identified shape, and everything that merely
 * looks like one must stay an ordinary failure: a backoff taken for a 500 would avoid a healthy pool,
 * and a pool avoided for no reason is a subscription the operator pays for and cannot use.
 */
const refusalOf = (stdout: string) => providerQuotaRefusal("anthropic", "claude-subscription", stdout);

test("a server error is not a quota refusal", () => {
  assert.equal(refusalOf(JSON.stringify({ type: "result", is_error: true, api_error_status: 500, terminal_reason: "api_error", result: "Internal server error" })), null);
  assert.equal(refusalOf(JSON.stringify({ type: "result", is_error: true, api_error_status: 503 })), null);
});

test("an auth failure is not a quota refusal", () => {
  assert.equal(refusalOf(JSON.stringify({ type: "result", is_error: true, api_error_status: 401, terminal_reason: "api_error", result: "unauthorized" })), null);
  assert.equal(refusalOf(JSON.stringify({ type: "result", is_error: true, api_error_status: 403, terminal_reason: "api_error", result: "forbidden" })), null);
  assert.equal(refusalOf(JSON.stringify({ type: "assistant", is_api_error_message: true, error: "authentication_error" })), null);
});

test("the word rate_limit alone is not enough: the marker must say it is an API error", () => {
  // A plain field named `error` can appear in any diagnostic line.
  assert.equal(refusalOf(JSON.stringify({ type: "result", error: "rate_limit" })), null);
  assert.equal(refusalOf(JSON.stringify({ type: "assistant", error: "rate_limit", text: "retrying" })), null);
  // With the API-error marker, the pair is the provider saying it refused this call.
  assert.ok(refusalOf(JSON.stringify({ type: "assistant", is_api_error_message: true, error: "rate_limit" })));
});

test("a 429 without the CLI's own terminal classification is not a quota refusal", () => {
  assert.equal(refusalOf(JSON.stringify({ type: "result", is_error: true, api_error_status: 429 })), null);
  // A 429 attributed to something other than an API error ending the run is likewise not ours to read.
  assert.equal(refusalOf(JSON.stringify({ type: "result", api_error_status: 429, terminal_reason: "max_turns" })), null);
  // The full pair is.
  assert.ok(refusalOf(JSON.stringify({ type: "result", is_error: true, api_error_status: 429, terminal_reason: "api_error" })));
});

test("prose that mentions a rate limit is not a quota refusal", () => {
  assert.equal(refusalOf("Error: rate limit exceeded, please try again later"), null);
  assert.equal(refusalOf("You've hit your session limit · resets 4:10am (Europe/Istanbul)"), null);
  assert.equal(refusalOf(JSON.stringify({ type: "result", subtype: "error_during_execution", result: "rate limit exceeded" })), null);
});
