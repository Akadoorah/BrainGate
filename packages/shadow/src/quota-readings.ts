import type { QuotaRefusalReason, ProviderQuotaRefusal } from "@braingate/core";
import type { ProviderId } from "@braingate/providers";

/**
 * A provider's own account of how much of its window is gone.
 *
 * BrainGate's routing has always compared pools against each other, because no provider was
 * thought to publish a balance — so the strongest model won every role until its pool ran out
 * for real, and the receipt could only say which pool had been busiest. Claude 2.1.266 does
 * publish one, on every headless run, in a `rate_limit_event` it emits before the answer:
 * `unifiedWindows.five_hour.utilization` and `seven_day.utilization`, each with a reset time.
 *
 * That is a real reading, not a comparison, and it outranks the local signal by the rule that
 * was already written down for the day a provider started reporting one.
 */
export interface QuotaReading {
  readonly providerId: ProviderId;
  /** Which window the reading describes, as the provider names it. */
  readonly window: string;
  /** Fraction of the window already used, 0 to 1. */
  readonly utilization: number;
  /** When the window rolls over, ISO-8601, or null when the provider did not say. */
  readonly resetAt: string | null;
  /** True when the provider says this run would be refused rather than served. */
  readonly blocked: boolean;
}

function ratio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function resetAt(value: unknown): string | null {
  // Seconds since the epoch, as the field arrives. A value that is not a plausible timestamp is
  // dropped rather than turned into 1970.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Every window a Claude run reported, newest event last.
 *
 * Read from the retained output rather than requested: the event arrives on its own, before the
 * answer, at no cost. A run that reported nothing yields nothing — an empty list is "the
 * provider did not say", which is a different fact from "the pool is fine".
 */
export function quotaReadings(providerId: ProviderId, stdout: string): readonly QuotaReading[] {
  if (providerId !== "anthropic") return Object.freeze([]);
  let latest: Record<string, unknown> | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (event.type !== "rate_limit_event") continue;
    const info = event.rate_limit_info;
    if (typeof info === "object" && info !== null) latest = info as Record<string, unknown>;
  }
  if (latest === null) return Object.freeze([]);

  // `status` describes the request that just ran, so it belongs to every window equally: a run
  // the provider refused says the pool is spent whichever window did it.
  const blocked = latest.status !== undefined && latest.status !== "allowed";
  const readings: QuotaReading[] = [];
  const windows = latest.unifiedWindows;
  if (typeof windows === "object" && windows !== null) {
    for (const [name, raw] of Object.entries(windows as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const record = raw as Record<string, unknown>;
      const utilization = ratio(record.utilization);
      if (utilization === null) continue;
      readings.push(Object.freeze({ providerId, window: name, utilization, resetAt: resetAt(record.resetsAt), blocked }));
    }
  }
  // Older builds report only the window that is closest, without the breakdown.
  if (readings.length === 0 && typeof latest.rateLimitType === "string") {
    const utilization = ratio(latest.utilization);
    if (utilization !== null) {
      readings.push(Object.freeze({ providerId, window: latest.rateLimitType, utilization, resetAt: resetAt(latest.resetsAt), blocked }));
    }
  }
  return Object.freeze(readings.sort((a, b) => a.window.localeCompare(b.window)));
}

/**
 * The one reading that should decide routing, when there is more than one.
 *
 * The fullest window, because that is the one that will refuse first. A five-hour window at 0.9
 * and a seven-day window at 0.4 is a pool to route away from now, whatever the weekly figure
 * says.
 */
export function bindingQuotaReading(readings: readonly QuotaReading[]): QuotaReading | null {
  if (readings.length === 0) return null;
  return [...readings].sort((a, b) => b.utilization - a.utilization)[0]!;
}

/**
 * How many helpers a run actually spawned inside the provider, by the provider's own count.
 *
 * BrainGate records one `provider_call` per CLI invocation, which is what it pays for and what
 * the budget bounds. A lead that spawns helpers of its own spends agent executions the budget
 * never saw: `maxConcurrentAgents` decided whether fan-out was allowed at all, and then nothing
 * counted it. That gap is how an orchestrator becomes a swarm nobody asked for.
 *
 * Claude reports it — `subagent_stats.{spawned,completed}` in the final envelope, measured
 * 2026-09-10. Where a provider reports nothing, the answer is `null`, which is recorded as
 * `unknown` rather than as zero: "nobody counted" and "none ran" are different facts, and
 * reading the first as the second is exactly how a limit stops being a limit.
 */
export interface SubagentUsage {
  readonly spawned: number;
  readonly completed: number;
}

export function subagentUsage(providerId: ProviderId, stdout: string): SubagentUsage | null {
  if (providerId !== "anthropic") return null;
  let latest: SubagentUsage | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    const stats = event.subagent_stats;
    if (typeof stats !== "object" || stats === null) continue;
    const record = stats as Record<string, unknown>;
    const spawned = record.spawned;
    const completed = record.completed;
    if (typeof spawned !== "number" || !Number.isInteger(spawned) || spawned < 0) continue;
    latest = Object.freeze({
      spawned,
      completed: typeof completed === "number" && Number.isInteger(completed) && completed >= 0 ? completed : 0,
    });
  }
  return latest;
}

/**
 * A refusal the provider stated in a machine-readable way, as opposed to a utilisation reading.
 *
 * Measured against the real thing on 2026-09-12 (Claude Code 2.1.268, subscription exhausted): the
 * CLI emits a stream line carrying `"error":"rate_limit"` with `is_api_error_message: true`, and a
 * final result envelope with `api_error_status: 429`, `is_error: true` and
 * `terminal_reason: "api_error"`. Its only reset information is the sentence
 * `You've hit your session limit · resets 4:10am (Europe/Istanbul)` — localized prose, with no
 * machine-readable instant anywhere in the payload.
 *
 * That shape is recognised here and nothing about it is guessed. The prose is kept as evidence; the
 * reset is `null` because the provider did not state one in a form that can be compared to a clock.
 * A refusal is therefore a fact about *this call*, and the routing state it feeds is task-local.
 */
function machineReadableReset(event: Record<string, unknown>): string | null {
  for (const key of ["resetsAt", "resetAt", "reset_at"]) {
    const value = event[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    // Seconds since the epoch, as these fields arrive; a millisecond value is implausibly large for
    // a window reset in this era, and is not accepted as one.
    if (value > 10_000_000_000) continue;
    const date = new Date(value * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

/**
 * Whether one output line is the provider refusing *this* call on quota.
 *
 * Two shapes count, and nothing else does:
 *
 * 1. `is_api_error_message: true` with `error: "rate_limit"` — the CLI marking a stream message as an
 *    API error *and* naming it a rate limit. Either half alone is not enough: `error: "rate_limit"`
 *    appears in ordinary prose and diagnostics, and `is_api_error_message` marks every API error.
 * 2. `api_error_status: 429` with `terminal_reason: "api_error"` — the HTTP status the provider
 *    returned, plus the CLI's own classification of how the run ended. This pair is sufficient
 *    *without* `error: "rate_limit"` because both halves are machine-readable facts about this call
 *    rather than descriptive text: 429 is the protocol's own statement that the request was refused
 *    for rate limiting, and `api_error` says the run ended on that API error rather than on the
 *    model's answer. Requiring the informal `error` string as well would make recognition depend on a
 *    label the CLI is free to rename, while the status code is the thing the provider actually sent.
 *    (Measured 2026-09-12: the real refusal carried both pairs.)
 *
 * Everything else — a 500, a 401, an authentication error, a timeout, prose that mentions a rate
 * limit — is a failure, but not a quota statement, and must not move routing or start a backoff.
 */
function refusedLine(event: Record<string, unknown>): boolean {
  if (event.is_api_error_message === true && event.error === "rate_limit") return true;
  return event.api_error_status === 429 && event.terminal_reason === "api_error";
}

function refusalDetail(event: Record<string, unknown>): string {
  if (typeof event.result === "string" && event.result.trim().length > 0) return event.result.trim();
  const content = event.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim().length > 0) return text.trim();
    }
  }
  return "";
}

/**
 * The provider's structured refusal of this call, or null when it did not state one.
 *
 * Null is the common case and the safe one: a non-zero exit with prose, a timeout, or a sandbox that
 * failed to apply are all refusals BrainGate understands as failures but *not* as quota statements,
 * and none of them may move routing.
 */
export function providerQuotaRefusal(
  providerId: string,
  quotaPool: string,
  stdout: string,
  now: Date = new Date(),
): ProviderQuotaRefusal | null {
  let found: { readonly reason: QuotaRefusalReason; readonly resetAt: string | null; readonly detail: string } | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (!refusedLine(event)) continue;
    const detail = refusalDetail(event);
    // The later line wins when it carries the provider's sentence (the result envelope does), but an
    // empty sentence never erases one already seen.
    const previous: string = found === null ? "the provider refused this call on quota" : found.detail;
    found = Object.freeze({
      reason: "rate_limit" as const,
      resetAt: machineReadableReset(event),
      detail: detail.length === 0 ? previous : detail,
    });
  }
  if (found === null) return null;
  return Object.freeze({
    providerId,
    quotaPool,
    reason: found.reason,
    observedAt: now.toISOString(),
    evidence: "native" as const,
    resetAt: found.resetAt,
    detail: found.detail.slice(0, 500),
  });
}
