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
