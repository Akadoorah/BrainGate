import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BrainGateInvariantError, type UsageEvidence } from "@braingate/core";
import { redactSecrets } from "@braingate/security";

export type QuotaStatus = "healthy" | "limited" | "exhausted" | "unknown";

export interface QuotaSnapshotInput {
  readonly provider: string;
  readonly quotaPool: string;
  readonly metric: string;
  readonly window?: string | null;
  readonly value?: number | null;
  readonly unit?: string | null;
  readonly resetAt?: string | null;
  readonly status: QuotaStatus;
  readonly evidence: UsageEvidence;
  readonly source?: string | null;
  readonly observedAt?: string;
}

export interface QuotaSnapshot {
  readonly sequence: number;
  readonly provider: string;
  readonly quotaPool: string;
  readonly metric: string;
  readonly window: string | null;
  readonly value: number | null;
  readonly unit: string | null;
  readonly resetAt: string | null;
  readonly status: QuotaStatus;
  readonly evidence: UsageEvidence;
  readonly source: string | null;
  readonly observedAt: string;
}

interface QuotaRow {
  sequence: number;
  provider: string;
  quota_pool: string;
  metric: string;
  window_name: string | null;
  value: number | null;
  unit: string | null;
  reset_at: string | null;
  status: QuotaStatus;
  evidence: UsageEvidence;
  source: string | null;
  observed_at: string;
}

const VALID_STATUS = new Set<QuotaStatus>(["healthy", "limited", "exhausted", "unknown"]);

/** Metrics that describe how much of a pool is left, and so depend on its status being known. */
const LEVEL_METRICS = new Set(["remaining", "limit", "used", "used_ratio", "pressure"]);

/**
 * How full a provider's window looked when it last said so, as a ratio.
 *
 * Named apart from `pressure` deliberately. `pressure` claims to be a current level of the pool
 * and is refused alongside an unknown status; this metric is an observation of a *window*, anchored
 * to the moment it was taken and to the reset it belongs to, and it is read back as a hint rather
 * than as a statement about availability.
 */
export const WINDOW_UTILIZATION_METRIC = "window_utilization";
/** The metric a locally derived load share is stored under. */
export const POOL_PRESSURE_METRIC = "pressure";
const VALID_EVIDENCE = new Set<UsageEvidence>(["native", "measured", "estimated", "unknown"]);

function clean(value: string, label: string, maxLength = 240): string {
  const result = redactSecrets(value).replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLength);
  if (result.length === 0) throw new BrainGateInvariantError("QUOTA_FIELD_INVALID", `${label} must be non-empty.`);
  return result;
}

function timestamp(value: string | undefined, label: string): string {
  const candidate = value ?? new Date().toISOString();
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new BrainGateInvariantError("QUOTA_TIMESTAMP_INVALID", `${label} must be an ISO timestamp.`);
  return date.toISOString();
}

function nullableTimestamp(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return timestamp(value, "resetAt");
}

function mapRow(row: QuotaRow): QuotaSnapshot {
  return Object.freeze({
    sequence: row.sequence,
    provider: row.provider,
    quotaPool: row.quota_pool,
    metric: row.metric,
    window: row.window_name,
    value: row.value,
    unit: row.unit,
    resetAt: row.reset_at,
    status: row.status,
    evidence: row.evidence,
    source: row.source,
    observedAt: row.observed_at,
  });
}

/**
 * How long BrainGate avoids a pool that just refused it, before letting the next task try again.
 *
 * This is a policy number, not a provider fact, and it is deliberately short. The one refusal
 * BrainGate has measured (2026-09-12, Claude Code 2.1.268) stated its own reset as ~5 minutes away
 * ("resets 4:10am (Europe/Istanbul)" for a session limit at 01:05Z); the failure mode being fixed
 * was a burst of tasks re-probing the same exhausted subscription within seconds. Ten minutes stops
 * that loop, and costs at most one wasted probe per pool per ten minutes if the provider comes back
 * sooner. It is never presented as a reset time, and it never sets `quotaState`.
 */
export const REFUSAL_BACKOFF_MS = 10 * 60_000;

/** The provenance of every backoff row: a local decision, from a provider's own refusal. */
export const REFUSAL_BACKOFF_POLICY = "operational-backoff";

export interface RefusalBackoffInput {
  readonly provider: string;
  readonly quotaPool: string;
  /** Why the pool was refused, in the provider's terms (`rate_limit`). */
  readonly reason: string;
  /** Task whose refusal caused this, when one is known. */
  readonly sourceTaskId?: string | null;
  readonly detail?: string | null;
  readonly observedAt?: string;
  /** Overridable only so tests can place a backoff in the past; never used to lengthen one. */
  readonly backoffMs?: number;
}

export interface RefusalBackoff {
  readonly sequence: number;
  readonly provider: string;
  readonly quotaPool: string;
  readonly reason: string;
  readonly evidence: "native";
  readonly policy: typeof REFUSAL_BACKOFF_POLICY;
  /**
   * When the *policy* stops applying — not when the provider's quota resets.
   *
   * Named apart from `resetAt` on purpose: nothing may read this as a provider statement, and no
   * surface may render it as "exhausted until".
   */
  readonly policyBackoffUntil: string;
  readonly sourceTaskId: string | null;
  readonly detail: string | null;
  readonly observedAt: string;
}

interface BackoffRow {
  sequence: number;
  provider: string;
  quota_pool: string;
  op: string;
  reason: string;
  evidence: string;
  policy: string;
  policy_backoff_until: string | null;
  source_task_id: string | null;
  detail: string | null;
  observed_at: string;
}

function mapBackoff(row: BackoffRow): RefusalBackoff {
  return Object.freeze({
    sequence: row.sequence,
    provider: row.provider,
    quotaPool: row.quota_pool,
    reason: row.reason,
    evidence: "native" as const,
    policy: REFUSAL_BACKOFF_POLICY,
    policyBackoffUntil: row.policy_backoff_until ?? row.observed_at,
    sourceTaskId: row.source_task_id,
    detail: row.detail,
    observedAt: row.observed_at,
  });
}

/**
 * How an active backoff reads to the operator, in the one place every surface that shows one goes
 * through: BrainGate's own decision to wait a little before trying a pool that just refused it,
 * never a provider limit, a quota reading, or a reset time (ADR 0012).
 *
 * `policyBackoffUntil` is a local clock, not the provider's, and the wording says so: "resting"
 * names what BrainGate is doing, "after a refusal" names the trigger, and "not counted as a limit"
 * heads off the reading nobody here is allowed to imply.
 */
export function describeRefusalBackoff(backoff: RefusalBackoff): string {
  const until = new Date(backoff.policyBackoffUntil);
  const clock = Number.isNaN(until.getTime()) ? backoff.policyBackoffUntil : until.toTimeString().slice(0, 5);
  return `BrainGate is resting ${backoff.quotaPool} until ${clock} after a refusal; it was not counted as a limit.`;
}

export class GlobalQuotaStore {
  readonly databasePath: string;
  readonly #db: Database.Database;

  constructor(globalStateDir: string) {
    mkdirSync(globalStateDir, { recursive: true });
    this.databasePath = join(globalStateDir, "quota.sqlite");
    this.#db = new Database(this.databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  record(input: QuotaSnapshotInput): QuotaSnapshot {
    if (!VALID_STATUS.has(input.status)) throw new BrainGateInvariantError("QUOTA_STATUS_INVALID", "Unsupported quota status.");
    if (!VALID_EVIDENCE.has(input.evidence)) throw new BrainGateInvariantError("QUOTA_EVIDENCE_INVALID", "Unsupported quota evidence.");
    const value = input.value ?? null;
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new BrainGateInvariantError("QUOTA_VALUE_INVALID", "Quota value must be null or a non-negative finite number.");
    }
    // A pool's *level* — what is left, what the ceiling is, how close it is to either — cannot
    // be stated while its status is unknown, because that is the pairing a reader turns into
    // "unknown · 87%".
    //
    // Not every row is a level. What BrainGate itself spent is a fact whether or not the pool's
    // health is known, and refusing it forced the choice between dropping the number and
    // claiming a health reading nobody took. The rule now says what it always meant.
    if (input.status === "unknown" && value !== null && LEVEL_METRICS.has(input.metric)) {
      throw new BrainGateInvariantError("QUOTA_UNKNOWN_VALUE", `Unknown quota status cannot carry a ${input.metric} value.`);
    }
    if (input.evidence === "unknown" && value !== null) {
      throw new BrainGateInvariantError("QUOTA_UNKNOWN_VALUE", "Unknown quota evidence cannot carry a numeric value.");
    }
    const provider = clean(input.provider, "provider", 120);
    const quotaPool = clean(input.quotaPool, "quotaPool", 160);
    const metric = clean(input.metric, "metric", 160);
    const windowName = input.window === undefined || input.window === null ? null : clean(input.window, "window", 120);
    const unit = input.unit === undefined || input.unit === null ? null : clean(input.unit, "unit", 60);
    const source = input.source === undefined || input.source === null ? null : clean(input.source, "source", 240);
    const observedAt = timestamp(input.observedAt, "observedAt");
    const resetAt = nullableTimestamp(input.resetAt);

    const result = this.#db.prepare(`
      INSERT INTO quota_snapshots (
        provider, quota_pool, metric, window_name, value, unit, reset_at, status, evidence, source, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(provider, quotaPool, metric, windowName, value, unit, resetAt, input.status, input.evidence, source, observedAt);
    const row = this.#db.prepare("SELECT * FROM quota_snapshots WHERE sequence = ?").get(Number(result.lastInsertRowid)) as QuotaRow;
    return mapRow(row);
  }

  latest(): readonly QuotaSnapshot[] {
    const rows = this.#db.prepare("SELECT * FROM quota_snapshots ORDER BY sequence DESC").all() as QuotaRow[];
    const seen = new Set<string>();
    const latest: QuotaSnapshot[] = [];
    for (const row of rows) {
      const key = `${row.provider}\u0000${row.quota_pool}\u0000${row.metric}\u0000${row.window_name ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(mapRow(row));
    }
    latest.sort((a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.quotaPool.localeCompare(b.quotaPool) ||
      a.metric.localeCompare(b.metric) ||
      (a.window ?? "").localeCompare(b.window ?? ""),
    );
    return Object.freeze(latest);
  }

  /**
   * Every row observed at or after `since`, oldest first.
   *
   * `latest()` answers "what is the current reading", which is the wrong question for anything
   * that accumulates: a pool's recent spend is the sum of what was recorded, not the last row.
   */
  since(observedAt: string, metric?: string): readonly QuotaSnapshot[] {
    const from = timestamp(observedAt, "since");
    const rows = metric === undefined
      ? this.#db.prepare("SELECT * FROM quota_snapshots WHERE observed_at >= ? ORDER BY sequence ASC").all(from) as QuotaRow[]
      : this.#db.prepare("SELECT * FROM quota_snapshots WHERE observed_at >= ? AND metric = ? ORDER BY sequence ASC").all(from, metric) as QuotaRow[];
    return Object.freeze(rows.map(mapRow));
  }

  history(limit = 200): readonly QuotaSnapshot[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.#db.prepare("SELECT * FROM quota_snapshots ORDER BY sequence DESC LIMIT ?").all(safeLimit) as QuotaRow[];
    return Object.freeze(rows.map(mapRow));
  }

  /**
   * Records that a provider refused this pool, and that BrainGate will avoid it briefly.
   *
   * Separate from `record()` in this class and separate in storage: a refusal is evidence about a
   * call, a snapshot is a statement about a pool, and a backoff is neither — it is a local decision
   * about what to try next. Keeping them in one table is how a policy guess becomes a quota claim.
   *
   * Best-effort and idempotent: this row is written to a different database from the task ledger, and
   * nothing here is transactional across the two. Losing a write costs one redundant provider probe
   * later; it cannot change quota truth or what any task recorded. The state is decided by
   * `observed_at` (with the append sequence only as a tie-break), so writing the same fact twice, or
   * out of order, is harmless.
   */
  recordRefusalBackoff(input: RefusalBackoffInput): RefusalBackoff {
    const provider = clean(input.provider, "provider", 120);
    const quotaPool = clean(input.quotaPool, "quotaPool", 160);
    const reason = clean(input.reason, "reason", 120);
    const observedAt = timestamp(input.observedAt, "observedAt");
    const backoffMs = input.backoffMs ?? REFUSAL_BACKOFF_MS;
    if (!Number.isFinite(backoffMs) || backoffMs <= 0) throw new BrainGateInvariantError("QUOTA_BACKOFF_INVALID", "Backoff must be a positive duration.");
    const until = new Date(Date.parse(observedAt) + backoffMs).toISOString();
    const sourceTaskId = input.sourceTaskId === undefined || input.sourceTaskId === null ? null : clean(input.sourceTaskId, "sourceTaskId", 120);
    const detail = input.detail === undefined || input.detail === null ? null : clean(input.detail, "detail", 500);
    const result = this.#db.prepare(`
      INSERT INTO refusal_backoffs (provider, quota_pool, op, reason, evidence, policy, policy_backoff_until, source_task_id, detail, observed_at)
      VALUES (?, ?, 'refuse', ?, 'native', ?, ?, ?, ?, ?)
    `).run(provider, quotaPool, reason, REFUSAL_BACKOFF_POLICY, until, sourceTaskId, detail, observedAt);
    return mapBackoff(this.#db.prepare("SELECT * FROM refusal_backoffs WHERE sequence = ?").get(Number(result.lastInsertRowid)) as BackoffRow);
  }

  /**
   * Supersedes any active backoff for a pool, because a call to it has just succeeded.
   *
   * Appended rather than updated, like everything else here: the record of having backed off is
   * worth keeping, and "it worked" is exactly the evidence that should end the policy.
   */
  clearRefusalBackoff(input: { readonly provider: string; readonly quotaPool: string; readonly sourceTaskId?: string | null; readonly observedAt?: string }): RefusalBackoff {
    const provider = clean(input.provider, "provider", 120);
    const quotaPool = clean(input.quotaPool, "quotaPool", 160);
    const observedAt = timestamp(input.observedAt, "observedAt");
    const sourceTaskId = input.sourceTaskId === undefined || input.sourceTaskId === null ? null : clean(input.sourceTaskId, "sourceTaskId", 120);
    const result = this.#db.prepare(`
      INSERT INTO refusal_backoffs (provider, quota_pool, op, reason, evidence, policy, policy_backoff_until, source_task_id, detail, observed_at)
      VALUES (?, ?, 'clear', 'served', 'native', ?, NULL, ?, NULL, ?)
    `).run(provider, quotaPool, REFUSAL_BACKOFF_POLICY, sourceTaskId, observedAt);
    return mapBackoff(this.#db.prepare("SELECT * FROM refusal_backoffs WHERE sequence = ?").get(Number(result.lastInsertRowid)) as BackoffRow);
  }

  /**
   * The pools BrainGate is currently avoiding, with the time the avoidance lapses.
   *
   * The newest row per pool decides, and only a `refuse` row whose window has not lapsed counts.
   * An expired backoff simply stops applying — the next task probes the pool again, which is the
   * only way a prober can learn the provider came back.
   */
  activeRefusalBackoffs(now: number = Date.now()): readonly RefusalBackoff[] {
    // Newest *observed fact* wins, not newest row: the writes are separate statements to separate
    // stores and can land out of order — a success observed at 01:00 whose `clear` is persisted
    // after a refusal observed at 01:00:05 must not supersede it. `observed_at` is the provider
    // event's own time, never BrainGate's write time, and `sequence` decides only a genuine tie.
    const rows = this.#db.prepare("SELECT * FROM refusal_backoffs ORDER BY observed_at DESC, sequence DESC").all() as BackoffRow[];
    const seen = new Set<string>();
    const active: RefusalBackoff[] = [];
    for (const row of rows) {
      const key = `${row.provider}\u0000${row.quota_pool}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.op !== "refuse") continue;
      const until = row.policy_backoff_until;
      if (until === null || Date.parse(until) <= now) continue;
      active.push(mapBackoff(row));
    }
    active.sort((a, b) => a.provider.localeCompare(b.provider) || a.quotaPool.localeCompare(b.quotaPool));
    return Object.freeze(active);
  }

  /** Every backoff decision, in the order it was observed, for the record and for the surfaces that explain one. */
  refusalBackoffHistory(limit = 200): readonly RefusalBackoff[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.#db.prepare("SELECT * FROM refusal_backoffs ORDER BY observed_at ASC, sequence ASC LIMIT ?").all(safeLimit) as BackoffRow[];
    return Object.freeze(rows.map(mapBackoff));
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        quota_pool TEXT NOT NULL,
        metric TEXT NOT NULL,
        window_name TEXT,
        value REAL,
        unit TEXT,
        reset_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('healthy', 'limited', 'exhausted', 'unknown')),
        evidence TEXT NOT NULL CHECK (evidence IN ('native', 'measured', 'estimated', 'unknown')),
        source TEXT,
        observed_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS quota_snapshots_no_update
      BEFORE UPDATE ON quota_snapshots BEGIN
        SELECT RAISE(ABORT, 'quota snapshots are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS quota_snapshots_no_delete
      BEFORE DELETE ON quota_snapshots BEGIN
        SELECT RAISE(ABORT, 'quota snapshots are append-only');
      END;
      CREATE INDEX IF NOT EXISTS idx_quota_identity_sequence
      ON quota_snapshots(provider, quota_pool, metric, window_name, sequence DESC);

      -- Operational refusal backoff: BrainGate's own short-lived decision to leave a pool alone.
      -- It lives beside the readings and never inside them: nothing that reads provider quota truth
      -- reads this table, and nothing here can be mistaken for a reset time.
      CREATE TABLE IF NOT EXISTS refusal_backoffs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        quota_pool TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('refuse', 'clear')),
        reason TEXT NOT NULL,
        evidence TEXT NOT NULL CHECK (evidence = 'native'),
        policy TEXT NOT NULL CHECK (policy = 'operational-backoff'),
        policy_backoff_until TEXT,
        source_task_id TEXT,
        detail TEXT,
        observed_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS refusal_backoffs_no_update
      BEFORE UPDATE ON refusal_backoffs BEGIN
        SELECT RAISE(ABORT, 'refusal backoffs are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS refusal_backoffs_no_delete
      BEFORE DELETE ON refusal_backoffs BEGIN
        SELECT RAISE(ABORT, 'refusal backoffs are append-only');
      END;
      CREATE INDEX IF NOT EXISTS idx_refusal_backoff_identity_sequence
      ON refusal_backoffs(provider, quota_pool, sequence DESC);
    `);
  }
}

/**
 * Opens the quota store, or says which file could not be opened and why.
 *
 * `~/.braingate` is the operator's own state and is not always writable: a home on a read-only
 * volume, another process holding the database, a sandbox that denies the path. What must not
 * happen is that a run dies as `CLI_UNEXPECTED` with the details suppressed, because that tells the
 * operator neither what failed nor what to change — and it reads as a bug in the run rather than a
 * problem with a directory. The store is the same store; only the failure is given a name.
 */
export function openQuotaStore(globalStateDir: string): GlobalQuotaStore {
  try {
    return new GlobalQuotaStore(globalStateDir);
  } catch (error) {
    const path = join(globalStateDir, "quota.sqlite");
    const reason = error instanceof Error ? error.message : String(error);
    throw new BrainGateInvariantError(
      "QUOTA_STORE_UNAVAILABLE",
      `Quota history at ${path} could not be opened: ${reason}. Make that path writable, or point BRAINGATE_HOME at a writable directory, then retry.`,
    );
  }
}
