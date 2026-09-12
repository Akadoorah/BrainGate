import type { DashboardSnapshot, DashboardTaskCard, ProviderQuotaCard } from "@braingate/observability";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function evidenceBadges(values: readonly string[]): string {
  if (values.length === 0) return '<span class="badge unknown">UNKNOWN</span>';
  return values.map((value) => `<span class="badge ${escapeHtml(value)}">${escapeHtml(value.toUpperCase())}</span>`).join(" ");
}

function metricValue(value: number | null, unit: string | null): string {
  if (value === null) return "Unknown";
  return `${escapeHtml(value)}${unit === null ? "" : ` ${escapeHtml(unit)}`}`;
}

function providerCard(card: ProviderQuotaCard): string {
  const metrics = card.metrics.map((metric) => `
    <div class="metric">
      <div><strong>${escapeHtml(metric.metric)}</strong>${metric.window === null ? "" : ` · ${escapeHtml(metric.window)}`}</div>
      <div class="metric-value">${metricValue(metric.value, metric.unit)}</div>
      <div>${evidenceBadges([metric.evidence])}</div>
    </div>`).join("");
  return `<article class="card provider-card">
    <div class="card-head"><div><h3>${escapeHtml(card.provider)}</h3><p>${escapeHtml(card.quotaPool)}</p></div><span class="status ${escapeHtml(card.status)}">${escapeHtml(card.status)}</span></div>
    <div class="metrics">${metrics}</div>
    <div class="meta">Observed ${escapeHtml(card.observedAt)}${card.resetAt === null ? "" : ` · Reset ${escapeHtml(card.resetAt)}`}</div>
    ${card.refusalBackoffUntil === null ? "" : `<div class="meta">Backoff until ${escapeHtml(card.refusalBackoffUntil)} — BrainGate policy after a ${escapeHtml(card.refusalBackoffReason ?? "quota")} refusal; this is not a provider reset and not an exhaustion verdict.</div>`}
  </article>`;
}

function routeLine(task: DashboardTaskCard): string {
  if (task.route.length === 0) return '<span class="muted">No route recorded</span>';
  return task.route.map((role) => `${escapeHtml(role.role)}: <strong>${escapeHtml(role.providerId)}</strong> / ${escapeHtml(role.modelId)}`).join(" · ");
}

/**
 * Who actually ran, which is not the same as who was routed.
 *
 * The plan's line above says what the task intended; this says what happened, one entry per
 * provider/model that was dispatched, with the status that tells the two apart. A planner that
 * executed on another provider appears here even when the plan never named it.
 */
function executionLine(task: DashboardTaskCard): string {
  if (task.execution.length === 0) return "";
  // The workspace is shown beside the model because it is part of what the role did: a provider that
  // read a copy of the project and one that read the checkout are different facts about a task.
  const entries = task.execution.map((role) => `${escapeHtml(role.role)}: <strong>${escapeHtml(role.providerId)}</strong> / ${escapeHtml(role.modelId)} <span class="status ${role.status === "completed" ? "native" : role.status === "attempted" ? "limited" : "unknown"}">${escapeHtml(role.status ?? "planned")}</span>${role.workspaceMode === undefined ? "" : ` <span class="muted">${escapeHtml(role.workspaceMode)}</span>`}`).join(" · ");
  return `<p class="muted">Executed: ${entries}</p>`;
}

function refusalLine(task: DashboardTaskCard): string {
  const refusal = task.quotaRefusal;
  if (refusal === null) return "";
  const reset = refusal.resetAt === null ? "no machine-readable reset given" : `reset ${refusal.resetAt}`;
  return `<p class="muted">Quota refusal · <strong>${escapeHtml(refusal.providerId)}</strong> / ${escapeHtml(refusal.quotaPool)} · ${escapeHtml(refusal.reason)} · ${escapeHtml(refusal.observedAt)} · ${escapeHtml(reset)} · ${escapeHtml(refusal.detail)}</p>`;
}

function taskCard(task: DashboardTaskCard): string {
  const budget = task.budget === null ? "No workflow budget receipt" : `${task.budget.providerCalls} calls · ${task.budget.contextTokens} ctx tokens · ${task.budget.repairRounds} repairs · ${task.budget.councilRounds} council`;
  return `<article class="card task-card">
    <div class="card-head"><div><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.projectName)} · ${escapeHtml(task.taskId)}</p></div><span class="status ${escapeHtml(task.state)}">${escapeHtml(task.state)}</span></div>
    <div class="task-grid"><span>Tier</span><strong>${escapeHtml(task.complexity ?? "Unknown")}</strong><span>Risk</span><strong>${escapeHtml(task.risk ?? "Unknown")}</strong><span>Approval</span><strong>${escapeHtml(task.approvalStatus ?? "Unknown")}</strong></div>
    <p>${routeLine(task)}</p>
    ${executionLine(task)}
    ${refusalLine(task)}
    <p class="muted">${escapeHtml(budget)}</p>
    <div>${evidenceBadges(task.usageProvenance)}</div>
  </article>`;
}

export function renderDashboardHtml(snapshot: DashboardSnapshot): string {
  const providers = snapshot.providers.length === 0 ? '<p class="empty">No provider quota snapshots yet.</p>' : snapshot.providers.map(providerCard).join("");
  const active = snapshot.activeTasks.length === 0 ? '<p class="empty">No active tasks.</p>' : snapshot.activeTasks.map(taskCard).join("");
  const recent = snapshot.recentTasks.length === 0 ? '<p class="empty">No task history yet.</p>' : snapshot.recentTasks.map(taskCard).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BrainGate</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color-scheme:dark;background:#0b0d10;color:#eef2f6}body{margin:0;background:radial-gradient(circle at top,#17202a 0,#0b0d10 38%);min-height:100vh}.shell{max-width:1280px;margin:auto;padding:32px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:28px}.hero h1{font-size:38px;margin:0}.hero p,.muted,.meta,.card-head p{color:#94a3b8}.section{margin:32px 0}.section h2{font-size:18px;letter-spacing:.04em;text-transform:uppercase;color:#cbd5e1}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.card{background:rgba(19,25,32,.92);border:1px solid #26313d;border-radius:16px;padding:18px;box-shadow:0 16px 45px rgba(0,0,0,.22)}.card-head{display:flex;justify-content:space-between;gap:14px}.card h3{margin:0 0 4px}.card p{margin:5px 0 12px;overflow-wrap:anywhere}.status,.badge{font-size:11px;text-transform:uppercase;letter-spacing:.06em;border:1px solid #334155;border-radius:999px;padding:5px 8px;height:max-content}.healthy,.native{border-color:#166534;color:#86efac}.limited,.estimated{border-color:#854d0e;color:#fde68a}.exhausted{border-color:#991b1b;color:#fca5a5}.unknown{border-color:#475569;color:#cbd5e1}.measured{border-color:#1d4ed8;color:#93c5fd}.metrics{display:grid;gap:8px;margin-top:14px}.metric{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:10px;background:#0f141a;border-radius:10px}.metric-value{font-variant-numeric:tabular-nums}.task-grid{display:grid;grid-template-columns:auto 1fr auto 1fr auto 1fr;gap:8px 10px;background:#0f141a;border-radius:10px;padding:10px;font-size:13px}.empty{padding:18px;border:1px dashed #334155;border-radius:12px;color:#94a3b8}.legend{display:flex;gap:8px;flex-wrap:wrap}.meta{font-size:12px;margin-top:12px}@media(max-width:700px){.shell{padding:20px}.hero{display:block}.task-grid{grid-template-columns:auto 1fr}}
</style></head><body><main class="shell">
<header class="hero"><div><h1>BrainGate</h1><p>Local AI engineering control plane</p></div><div class="meta">Snapshot ${escapeHtml(snapshot.generatedAt)}</div></header>
<section class="section"><h2>Provider quota</h2><div class="grid">${providers}</div></section>
<section class="section"><h2>Active tasks</h2><div class="grid">${active}</div></section>
<section class="section"><h2>Recent receipts</h2><div class="grid">${recent}</div></section>
<section class="section"><h2>Provenance</h2><div class="legend">${evidenceBadges(snapshot.provenanceLegend)}</div></section>
</main></body></html>`;
}
