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
    `);
  }
}
