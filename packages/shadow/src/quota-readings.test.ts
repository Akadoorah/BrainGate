import test from "node:test";
import assert from "node:assert/strict";
import { bindingQuotaReading, quotaReadings } from "./quota-readings.js";

/** Copied from a real `claude --output-format stream-json` run on 2026-09-10. */
const EVENT = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1789015200,
    rateLimitType: "five_hour",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.2, resetsAt: 1789015200 },
      seven_day: { utilization: 0.43, resetsAt: 1789200000 },
    },
  },
});

test("a Claude run reports how much of each window it has already spent", () => {
  const readings = quotaReadings("anthropic", `${EVENT}\n{"type":"result","result":"ok"}`);
  assert.deepEqual(readings.map((reading) => reading.window), ["five_hour", "seven_day"]);
  assert.equal(readings[0]!.utilization, 0.2);
  assert.equal(readings[1]!.utilization, 0.43);
  assert.equal(readings[0]!.resetAt, new Date(1789015200 * 1000).toISOString());
  assert.equal(readings[0]!.blocked, false);
});

test("the window that will refuse first is the one routing should believe", () => {
  const binding = bindingQuotaReading(quotaReadings("anthropic", EVENT));
  assert.equal(binding?.window, "seven_day");
  assert.equal(binding?.utilization, 0.43);
});

test("a refused run marks every window spent, whichever one refused it", () => {
  const blocked = EVENT.replace('"status":"allowed"', '"status":"rejected"');
  for (const reading of quotaReadings("anthropic", blocked)) assert.equal(reading.blocked, true);
});

test("silence is not a healthy pool", () => {
  assert.deepEqual([...quotaReadings("anthropic", '{"type":"result","result":"ok"}')], []);
  assert.deepEqual([...quotaReadings("anthropic", "not json")], []);
  assert.equal(bindingQuotaReading([]), null);
});

test("a provider that publishes nothing is never read as if it had", () => {
  assert.deepEqual([...quotaReadings("xai", EVENT)], [], "only the provider whose event shape was measured is parsed");
  assert.deepEqual([...quotaReadings("google", EVENT)], []);
});

test("an implausible figure is dropped rather than routed on", () => {
  const nonsense = EVENT.replace('"utilization":0.2', '"utilization":7').replace('"utilization":0.43', '"utilization":-1');
  assert.deepEqual([...quotaReadings("anthropic", nonsense)], []);
  const noReset = EVENT.replace('"resetsAt":1789015200,\n', "").replace('{"utilization":0.2,"resetsAt":1789015200}', '{"utilization":0.2,"resetsAt":0}');
  assert.equal(quotaReadings("anthropic", noReset)[0]!.resetAt, null);
});

test("an older build that reports only the closest window is still read", () => {
  const older = JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.61, resetsAt: 1789015200 },
  });
  const readings = quotaReadings("anthropic", older);
  assert.equal(readings.length, 1);
  assert.equal(readings[0]!.window, "five_hour");
  assert.equal(readings[0]!.utilization, 0.61);
});
