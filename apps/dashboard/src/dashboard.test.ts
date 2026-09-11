import test from "node:test";
import assert from "node:assert/strict";
import type { DashboardSnapshot } from "@braingate/observability";
import { assertLoopbackHost, renderDashboardHtml, startDashboardServer } from "./index.js";

function snapshot(): DashboardSnapshot {
  return {
    generatedAt: "2026-09-07T02:00:00.000Z",
    providers: [{
      provider: "xai<script>alert(1)</script>", quotaPool: "grok-free", status: "unknown",
      observedAt: "2026-09-07T01:00:00.000Z", resetAt: null, provenances: ["unknown"],
      metrics: [{ sequence: 1, provider: "xai<script>alert(1)</script>", quotaPool: "grok-free", metric: "remaining", window: null, value: null, unit: "%", resetAt: null, status: "unknown", evidence: "unknown", source: null, observedAt: "2026-09-07T01:00:00.000Z" }],
    }],
    activeTasks: [{ taskId: "task-1", projectId: "waslo", projectName: "Waslo", title: "<img src=x onerror=alert(1)>", state: "running", complexity: "T2", risk: "medium", updatedAt: "2026-09-07T01:00:00.000Z", route: [], budget: null, approvalStatus: "pending", outcome: null, strictOutcome: null, reviewStatus: null, failureKind: null, reconciled: false, usageProvenance: [], tokensByModel: [] }],
    recentTasks: [],
    provenanceLegend: ["native", "measured", "estimated", "unknown"],
  };
}

test("renderer escapes dynamic HTML and never turns unknown quota into a fake percentage", () => {
  const html = renderDashboardHtml(snapshot());
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, />Unknown</);
  assert.doesNotMatch(html, />100 %</);
});

test("dashboard bind policy permits loopback and refuses external interfaces", async () => {
  assert.doesNotThrow(() => assertLoopbackHost("127.0.0.1"));
  assert.doesNotThrow(() => assertLoopbackHost("::1"));
  assert.throws(() => assertLoopbackHost("0.0.0.0"), /loopback/);
  await assert.rejects(() => startDashboardServer(snapshot, { host: "0.0.0.0", port: 0 }), /loopback/);
});

test("local server renders the provided snapshot without any provider-probe dependency", async () => {
  const started = await startDashboardServer(snapshot, { host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(started.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /BrainGate/);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});
