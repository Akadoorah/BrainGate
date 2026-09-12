import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  BrainGateInvariantError,
  OBSERVATION_OUTCOMES,
  assertRegisteredProject,
  isFailureKind,
  isObservationOutcome,
  type FailureKind,
  type ObservationInput,
  type ObservationRecord,
  type RegisteredProject,
  type TaskComplexity,
  type TaskReceipt,
  type TaskRisk,
} from "@braingate/core";
import { deriveDogfoodPrior, emptyDogfoodPrior, parseTaskComplexity, parseTaskRisk, type PriorSample } from "./prior.js";
import type {
  DogfoodFeedbackOutcome,
  DogfoodFeedbackRecord,
  DogfoodMode,
  DogfoodOutcome,
  DogfoodPrior,
  DogfoodRegressionRecord,
  DogfoodReport,
  DogfoodReviewerVerdict,
  DogfoodRole,
  DogfoodRunRecord,
  DogfoodUsage,
} from "./types.js";

/**
 * What a human may assert later about a run's real outcome.
 *
 * Deliberately narrower than the run vocabulary; see `DogfoodFeedbackOutcome`.
 */
const FEEDBACK_OUTCOME_LIST: readonly DogfoodFeedbackOutcome[] = ["success", "partial", "blocked", "failed"];
const FEEDBACK_OUTCOMES = new Set<DogfoodFeedbackOutcome>(FEEDBACK_OUTCOME_LIST);
const REVIEW_VERDICT_LIST: readonly Exclude<DogfoodReviewerVerdict, null>[] = ["approve", "request_changes", "disagree"];
const REVIEW_VERDICTS = new Set<Exclude<DogfoodReviewerVerdict, null>>(REVIEW_VERDICT_LIST);
const MODE_LIST: readonly DogfoodMode[] = ["ask", "write"];
const MODES = new Set<DogfoodMode>(MODE_LIST);
const COMPLEXITY_ORDER = ["T0", "T1", "T2", "T3", "T4"] as const;
const RISK_ORDER = ["low", "medium", "high", "critical"] as const;
/** Bumped when a column or constraint changes; the migration keys off it. */
const SCHEMA_VERSION = 2;

/**
 * A SQL `IN` list from the same runtime list the TypeScript guard reads.
 *
 * The CHECK constraint and the parser are two enforcements of one vocabulary; writing the SQL by
 * hand would let a sixth outcome be accepted by the code and rejected by the database, or worse,
 * accepted by the database and never counted.
 */
function sqlIn(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/**
 * The run table, defined once.
 *
 * A migration that rebuilds this table must produce exactly the columns and constraints a fresh
 * database gets, and the only way to be sure of that is for both to read the same definition.
 */
function runsTableSql(table: string): string {
  return `
    CREATE TABLE ${table} (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN (${sqlIn(MODE_LIST)})),
      predicted_complexity TEXT NOT NULL CHECK (predicted_complexity IN (${sqlIn(COMPLEXITY_ORDER)})),
      predicted_risk TEXT NOT NULL CHECK (predicted_risk IN (${sqlIn(RISK_ORDER)})),
      effective_complexity TEXT NOT NULL CHECK (effective_complexity IN (${sqlIn(COMPLEXITY_ORDER)})),
      effective_risk TEXT NOT NULL CHECK (effective_risk IN (${sqlIn(RISK_ORDER)})),
      rule_version TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN (${sqlIn(OBSERVATION_OUTCOMES)})),
      failure_kind TEXT NULL,
      reconciled INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0,1)),
      reviewer_verdict TEXT NULL CHECK (reviewer_verdict IS NULL OR reviewer_verdict IN (${sqlIn(REVIEW_VERDICT_LIST)})),
      usage_json TEXT NOT NULL,
      prior_json TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );`;
}

function runsTriggersSql(table: string): string {
  return `
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} are append-only'); END;
  `;
}

function schemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS dogfood_meta (
      project_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    ${runsTableSql("IF NOT EXISTS dogfood_runs")}
    CREATE TABLE IF NOT EXISTS dogfood_feedback (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      actual_complexity TEXT NOT NULL CHECK (actual_complexity IN (${sqlIn(COMPLEXITY_ORDER)})),
      actual_risk TEXT NULL CHECK (actual_risk IS NULL OR actual_risk IN (${sqlIn(RISK_ORDER)})),
      outcome TEXT NOT NULL CHECK (outcome IN (${sqlIn(FEEDBACK_OUTCOME_LIST)})),
      regression INTEGER NOT NULL CHECK (regression IN (0,1)),
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES dogfood_runs(task_id)
    );
    ${runsTriggersSql("dogfood_runs")}
    CREATE TRIGGER IF NOT EXISTS dogfood_feedback_no_update BEFORE UPDATE ON dogfood_feedback BEGIN SELECT RAISE(ABORT, 'dogfood_feedback is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS dogfood_feedback_no_delete BEFORE DELETE ON dogfood_feedback BEGIN SELECT RAISE(ABORT, 'dogfood_feedback is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS dogfood_meta_no_update BEFORE UPDATE ON dogfood_meta BEGIN SELECT RAISE(ABORT, 'dogfood_meta is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS dogfood_meta_no_delete BEFORE DELETE ON dogfood_meta BEGIN SELECT RAISE(ABORT, 'dogfood_meta is immutable'); END;
  `;
}

interface RunRow {
  sequence: number;
  project_id: string;
  task_id: string;
  mode: DogfoodMode;
  predicted_complexity: string;
  predicted_risk: string;
  effective_complexity: string;
  effective_risk: string;
  rule_version: string;
  roles_json: string;
  outcome: DogfoodOutcome;
  failure_kind: string | null;
  reconciled: number;
  reviewer_verdict: Exclude<DogfoodReviewerVerdict, null> | null;
  usage_json: string;
  prior_json: string;
  observed_at: string;
}

interface FeedbackRow {
  sequence: number;
  project_id: string;
  task_id: string;
  actual_complexity: string;
  actual_risk: string | null;
  outcome: DogfoodFeedbackOutcome;
  regression: number;
  recorded_at: string;
}

function now(): string { return new Date().toISOString(); }

function parseMode(value: unknown): DogfoodMode {
  if (typeof value !== "string" || !MODES.has(value as DogfoodMode)) throw new BrainGateInvariantError("DOGFOOD_MODE_INVALID", "Dogfood mode must be ask or write.");
  return value as DogfoodMode;
}

/** A run's outcome, validated against core's list so the corpus speaks the ledger's vocabulary. */
function parseOutcome(value: unknown): DogfoodOutcome {
  if (typeof value !== "string" || !isObservationOutcome(value)) throw new BrainGateInvariantError("DOGFOOD_OUTCOME_INVALID", "Dogfood run outcome must be success, partial, blocked, failed, interrupted, or unknown.");
  return value;
}

/** What a human asserts about a run afterwards, which cannot be "interrupted" or "unknown". */
function parseFeedbackOutcome(value: unknown): DogfoodFeedbackOutcome {
  if (typeof value !== "string" || !FEEDBACK_OUTCOMES.has(value as DogfoodFeedbackOutcome)) throw new BrainGateInvariantError("DOGFOOD_FEEDBACK_OUTCOME_INVALID", "Feedback outcome must be success, partial, blocked, or failed.");
  return value as DogfoodFeedbackOutcome;
}

function parseFailureKind(value: unknown): FailureKind | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !isFailureKind(value)) throw new BrainGateInvariantError("DOGFOOD_FAILURE_KIND_INVALID", "Dogfood failure kind is not a known failure kind.");
  return value;
}

function parseReviewerVerdict(value: unknown): DogfoodReviewerVerdict {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !REVIEW_VERDICTS.has(value as Exclude<DogfoodReviewerVerdict, null>)) throw new BrainGateInvariantError("DOGFOOD_REVIEW_INVALID", "Reviewer verdict must be approve, request_changes, disagree, or null.");
  return value as Exclude<DogfoodReviewerVerdict, null>;
}

function parsePrior(value: unknown, mode: DogfoodMode): DogfoodPrior {
  if (value === null || value === undefined) return emptyDogfoodPrior(mode);
  if (typeof value !== "object") throw new BrainGateInvariantError("DOGFOOD_PRIOR_INVALID", "Dogfood prior must be an object or null.");
  const prior = value as DogfoodPrior;
  if (prior.mode !== mode) throw new BrainGateInvariantError("DOGFOOD_PRIOR_MODE_MISMATCH", "Dogfood prior mode must match the recorded run mode.");
  return prior;
}

/**
 * What the store needs in order to write one observation.
 *
 * Core's `ObservationInput` plus the two things only the caller's own storage can supply: the
 * task's receipt, which carries the measured usage, and the reviewer's verdict, which is read from
 * the ledger's events rather than kept as a second copy of the decision.
 */
export interface DogfoodObservationInput extends ObservationInput {
  readonly receipt: TaskReceipt | null;
  readonly reviewerVerdict: DogfoodReviewerVerdict;
}

/** Shared with `recordFeedback`'s callers via core's `ObservationInput`, so it takes the subset it needs. */
function assertNoDeescalation(
  predicted: Readonly<{ complexity: TaskComplexity; risk: TaskRisk }>,
  effective: Readonly<{ complexity: TaskComplexity; risk: TaskRisk }>,
): void {
  if (COMPLEXITY_ORDER.indexOf(effective.complexity) < COMPLEXITY_ORDER.indexOf(predicted.complexity)) {
    throw new BrainGateInvariantError("DOGFOOD_DEESCALATION_FORBIDDEN", "Dogfood effective complexity cannot be lower than the classifier prediction.");
  }
  if (RISK_ORDER.indexOf(effective.risk) < RISK_ORDER.indexOf(predicted.risk)) {
    throw new BrainGateInvariantError("DOGFOOD_DEESCALATION_FORBIDDEN", "Dogfood effective risk cannot be lower than the classifier prediction.");
  }
}

function mapUsage(receipt: TaskReceipt): readonly DogfoodUsage[] {
  return Object.freeze(receipt.usage.map((usage) => Object.freeze({
    provider: usage.provider,
    model: usage.model,
    evidence: usage.evidence,
    metric: usage.metric,
    value: usage.value,
    unit: usage.unit,
  })));
}

function validateRoles(roles: readonly DogfoodRole[]): readonly DogfoodRole[] {
  return Object.freeze(roles.map((role) => {
    // Kept in step with WorkflowRole. A role the engine can route but the store rejects fails
    // the task after the work is done and paid for, which is how `planner` first surfaced.
    if (!["planner", "primary", "reviewer", "judge"].includes(role.role) || role.providerId.trim().length === 0 || role.modelId.trim().length === 0) {
      throw new BrainGateInvariantError("DOGFOOD_ROLE_INVALID", "Dogfood roles require a valid role, providerId and modelId.");
    }
    // `status` is carried through rather than dropped: the corpus has to be able to say whether a
    // role was routed, attempted or completed, and a stored row that lost that distinction is how a
    // planner that ran on another provider went missing.
    return Object.freeze({
      role: role.role,
      providerId: role.providerId.trim(),
      modelId: role.modelId.trim(),
      ...(role.status === undefined ? {} : { status: role.status }),
    });
  }));
}

function mapRun(row: RunRow): DogfoodRunRecord {
  return Object.freeze({
    sequence: row.sequence,
    projectId: row.project_id,
    taskId: row.task_id,
    mode: parseMode(row.mode),
    predictedComplexity: parseTaskComplexity(row.predicted_complexity),
    predictedRisk: parseTaskRisk(row.predicted_risk),
    effectiveComplexity: parseTaskComplexity(row.effective_complexity),
    effectiveRisk: parseTaskRisk(row.effective_risk),
    ruleVersion: row.rule_version,
    roles: Object.freeze(JSON.parse(row.roles_json) as DogfoodRole[]),
    outcome: parseOutcome(row.outcome),
    failureKind: parseFailureKind(row.failure_kind),
    reconciled: row.reconciled === 1,
    reviewerVerdict: parseReviewerVerdict(row.reviewer_verdict),
    usage: Object.freeze(JSON.parse(row.usage_json) as DogfoodUsage[]),
    prior: Object.freeze(JSON.parse(row.prior_json) as DogfoodPrior),
    observedAt: row.observed_at,
  });
}

function mapFeedback(row: FeedbackRow): DogfoodFeedbackRecord {
  return Object.freeze({
    sequence: row.sequence,
    projectId: row.project_id,
    taskId: row.task_id,
    actualComplexity: parseTaskComplexity(row.actual_complexity),
    actualRisk: row.actual_risk === null ? null : parseTaskRisk(row.actual_risk),
    outcome: parseFeedbackOutcome(row.outcome),
    regression: row.regression === 1,
    recordedAt: row.recorded_at,
  });
}

export class DogfoodStore {
  readonly #project: RegisteredProject;
  readonly #db: Database.Database;
  readonly databasePath: string;

  constructor(project: RegisteredProject) {
    assertRegisteredProject(project);
    this.#project = project;
    mkdirSync(project.storageDir, { recursive: true, mode: 0o700 });
    this.databasePath = join(project.storageDir, "dogfood.sqlite");
    this.#db = new Database(this.databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#migrate();
    const meta = this.#db.prepare("SELECT project_id FROM dogfood_meta LIMIT 1").get() as { project_id: string } | undefined;
    if (meta === undefined) this.#db.prepare("INSERT INTO dogfood_meta (project_id, schema_version, created_at) VALUES (?, 1, ?)").run(project.projectId, now());
    else if (meta.project_id !== project.projectId) throw new BrainGateInvariantError("DOGFOOD_PROJECT_MISMATCH", "Dogfood database belongs to a different project_id.");
  }

  close(): void { this.#db.close(); }

  /**
   * The single write path into the corpus.
   *
   * Called by the finalizer for every task, including the ones being repaired, which is what makes
   * the corpus complete rather than a record of the runs that happened to finish. Idempotent: the
   * same observation twice is the same observation, and a *different* observation for a task that
   * already has one is a conflict rather than an overwrite — this store cannot update, so the only
   * honest options are "already recorded" and "refuse".
   */
  recordObservation(input: DogfoodObservationInput): DogfoodRunRecord {
    const mode = parseMode(input.mode);
    const outcome = parseOutcome(input.outcome);
    const failureKind = parseFailureKind(input.failureKind);
    const reconciled = input.reconciled === true;
    const verdict = parseReviewerVerdict(input.reviewerVerdict);
    // The task a run belongs to is named by the receipt, when the caller has one. Without it the
    // store can still write, because the task id is the caller's to name and the store is already
    // scoped to one project.
    if (input.receipt !== null && input.receipt.task.projectId !== this.#project.projectId) throw new BrainGateInvariantError("DOGFOOD_PROJECT_MISMATCH", "Task receipt belongs to another project.");

    const existing = this.getRun(input.taskId);
    if (existing !== undefined) {
      if (existing.outcome === outcome && existing.failureKind === failureKind && existing.reconciled === reconciled) return existing;
      throw new BrainGateInvariantError("DOGFOOD_OBSERVATION_CONFLICT", `Task ${input.taskId} already has a different observation (${existing.outcome}${existing.failureKind === null ? "" : `/${existing.failureKind}`}); the corpus is append-only and will not be rewritten.`);
    }

    assertNoDeescalation(input.predicted, input.effective);
    const roles = validateRoles(input.roles);
    const prior = parsePrior(input.prior, mode);
    const usage = input.receipt === null ? Object.freeze([]) : mapUsage(input.receipt);
    this.#db.prepare(`
      INSERT INTO dogfood_runs (
        project_id, task_id, mode, predicted_complexity, predicted_risk,
        effective_complexity, effective_risk, rule_version, roles_json,
        outcome, failure_kind, reconciled, reviewer_verdict, usage_json, prior_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.#project.projectId,
      input.taskId,
      mode,
      input.predicted.complexity,
      input.predicted.risk,
      input.effective.complexity,
      input.effective.risk,
      input.predicted.ruleVersion,
      JSON.stringify(roles),
      outcome,
      failureKind,
      reconciled ? 1 : 0,
      verdict,
      JSON.stringify(usage),
      JSON.stringify(prior),
      now(),
    );
    return this.requireRun(input.taskId);
  }

  find(taskId: string): ObservationRecord | null {
    const run = this.getRun(taskId);
    return run === undefined ? null : Object.freeze({ sequence: run.sequence, outcome: run.outcome, failureKind: run.failureKind, reconciled: run.reconciled });
  }

  getRun(taskId: string): DogfoodRunRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM dogfood_runs WHERE project_id = ? AND task_id = ?").get(this.#project.projectId, taskId) as RunRow | undefined;
    return row === undefined ? undefined : mapRun(row);
  }

  requireRun(taskId: string): DogfoodRunRecord {
    const run = this.getRun(taskId);
    if (run === undefined) throw new BrainGateInvariantError("DOGFOOD_RUN_NOT_FOUND", `Task ${taskId} has no dogfood observation in project ${this.#project.projectId}.`);
    return run;
  }

  listRuns(): readonly DogfoodRunRecord[] {
    return Object.freeze((this.#db.prepare("SELECT * FROM dogfood_runs WHERE project_id = ? ORDER BY sequence ASC").all(this.#project.projectId) as RunRow[]).map(mapRun));
  }

  recordFeedback(input: {
    readonly taskId: string;
    readonly actualComplexity: unknown;
    readonly actualRisk?: unknown;
    readonly outcome: unknown;
    readonly regression?: boolean;
  }): DogfoodFeedbackRecord {
    this.requireRun(input.taskId);
    const complexity = parseTaskComplexity(input.actualComplexity);
    const risk = input.actualRisk === undefined || input.actualRisk === null ? null : parseTaskRisk(input.actualRisk);
    const outcome = parseOutcome(input.outcome);
    this.#db.prepare(`
      INSERT INTO dogfood_feedback (project_id, task_id, actual_complexity, actual_risk, outcome, regression, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(this.#project.projectId, input.taskId, complexity, risk, outcome, input.regression === true ? 1 : 0, now());
    const row = this.#db.prepare("SELECT * FROM dogfood_feedback WHERE project_id = ? AND task_id = ? ORDER BY sequence DESC LIMIT 1").get(this.#project.projectId, input.taskId) as FeedbackRow;
    return mapFeedback(row);
  }

  latestFeedback(): readonly DogfoodFeedbackRecord[] {
    const rows = this.#db.prepare(`
      SELECT f.* FROM dogfood_feedback f
      JOIN (
        SELECT task_id, MAX(sequence) AS max_sequence
        FROM dogfood_feedback WHERE project_id = ? GROUP BY task_id
      ) latest ON latest.task_id = f.task_id AND latest.max_sequence = f.sequence
      WHERE f.project_id = ? ORDER BY f.sequence ASC
    `).all(this.#project.projectId, this.#project.projectId) as FeedbackRow[];
    return Object.freeze(rows.map(mapFeedback));
  }

  derivePrior(mode: DogfoodMode, minimumSamples = 3): DogfoodPrior {
    // Reconciled runs are excluded: a prior is a claim about what the classifier did during a live
    // run, and a reconstructed record's roles and prior are inferences, not observations. Counting
    // them would let a repaired task change what the next task is routed as.
    const runs = new Map(this.listRuns().filter((run) => run.mode === mode && !run.reconciled).map((run) => [run.taskId, run]));
    const samples: PriorSample[] = [];
    for (const feedback of this.latestFeedback()) {
      const run = runs.get(feedback.taskId);
      if (run === undefined) continue;
      samples.push({ predictedComplexity: run.predictedComplexity, predictedRisk: run.predictedRisk, actualComplexity: feedback.actualComplexity, actualRisk: feedback.actualRisk });
    }
    return deriveDogfoodPrior(mode, samples, minimumSamples);
  }

  report(): DogfoodReport {
    const runs = this.listRuns();
    const live = runs.filter((run) => !run.reconciled);
    const reconciled = runs.filter((run) => run.reconciled);
    const feedback = this.latestFeedback();
    const runByTask = new Map(live.map((run) => [run.taskId, run]));
    let exact = 0; let under = 0; let over = 0; let regressions = 0;
    const complexityOrder = ["T0", "T1", "T2", "T3", "T4"] as const;
    for (const item of feedback) {
      const run = runByTask.get(item.taskId);
      if (run === undefined) continue;
      const predicted = complexityOrder.indexOf(run.predictedComplexity);
      const actual = complexityOrder.indexOf(item.actualComplexity);
      if (predicted === actual) exact += 1; else if (predicted < actual) under += 1; else over += 1;
      if (item.regression) regressions += 1;
    }
    // Built from core's own list, so adding a sixth outcome to the vocabulary cannot silently leave
    // a bucket missing here and a counter that adds to nothing.
    const emptyOutcomes = (): Record<DogfoodOutcome, number> => Object.fromEntries(OBSERVATION_OUTCOMES.map((outcome) => [outcome, 0])) as Record<DogfoodOutcome, number>;
    const outcomes = emptyOutcomes();
    const reconciledOutcomes = emptyOutcomes();
    const reviewerVerdicts: Record<"approve" | "request_changes" | "disagree" | "none", number> = { approve: 0, request_changes: 0, disagree: 0, none: 0 };
    const providers = new Map<string, { role: DogfoodRole["role"]; providerId: string; modelId: string; runs: number }>();
    for (const run of runs) {
      if (run.reconciled) {
        reconciledOutcomes[run.outcome] += 1;
        continue;
      }
      outcomes[run.outcome] += 1;
      reviewerVerdicts[run.reviewerVerdict ?? "none"] += 1;
      for (const role of run.roles) {
        const key = `${role.role}\u0000${role.providerId}\u0000${role.modelId}`;
        const current = providers.get(key);
        if (current === undefined) providers.set(key, { ...role, runs: 1 }); else current.runs += 1;
      }
    }
    const providerRows = [...providers.values()].sort((a, b) => a.role.localeCompare(b.role) || a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
    return Object.freeze({
      projectId: this.#project.projectId,
      runs: runs.length,
      observedRuns: live.length,
      reconciledRuns: reconciled.length,
      feedback: feedback.length,
      // Coverage is asked of the runs a human could actually have judged: a reconciled record is
      // not waiting for feedback, and counting it as missing would understate how much of the live
      // corpus has been reviewed.
      feedbackCoverage: live.length === 0 ? 0 : Math.round((feedback.length / live.length) * 1000) / 1000,
      exactComplexityMatches: exact,
      complexityUnderpredictions: under,
      complexityOverpredictions: over,
      regressions,
      outcomes: Object.freeze(outcomes),
      reconciledOutcomes: Object.freeze(reconciledOutcomes),
      reviewerVerdicts: Object.freeze(reviewerVerdicts),
      providers: Object.freeze(providerRows.map((row) => Object.freeze(row))),
      priors: Object.freeze({ ask: this.derivePrior("ask"), write: this.derivePrior("write") }),
    });
  }

  regressionJsonl(): string {
    const runByTask = new Map(this.listRuns().map((run) => [run.taskId, run]));
    const records: DogfoodRegressionRecord[] = [];
    for (const feedback of this.latestFeedback().filter((item) => item.regression)) {
      const run = runByTask.get(feedback.taskId);
      if (run === undefined) continue;
      records.push(Object.freeze({
        schemaVersion: 1,
        projectId: this.#project.projectId,
        taskId: run.taskId,
        mode: run.mode,
        predictedComplexity: run.predictedComplexity,
        effectiveComplexity: run.effectiveComplexity,
        actualComplexity: feedback.actualComplexity,
        predictedRisk: run.predictedRisk,
        effectiveRisk: run.effectiveRisk,
        actualRisk: feedback.actualRisk,
        outcome: feedback.outcome,
        reviewerVerdict: run.reviewerVerdict,
        roles: run.roles,
        feedbackRecordedAt: feedback.recordedAt,
      }));
    }
    records.sort((a, b) => a.taskId.localeCompare(b.taskId));
    return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
  }

  #migrate(): void {
    const existing = this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dogfood_runs'").get() as { name: string } | undefined;
    if (existing === undefined) {
      this.#db.exec(schemaSql());
      this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
      return;
    }
    const version = this.#db.pragma("user_version", { simple: true }) as number;
    if (version >= SCHEMA_VERSION) return;
    this.#migrateToV2();
  }

  /**
   * Widens the run outcome vocabulary and adds the failure kind and the reconciled flag.
   *
   * SQLite cannot alter a CHECK constraint, so the table is rebuilt around its own name and its
   * rows are carried across with their `sequence` values intact — the sequence is what a reader
   * uses to order the corpus, and renumbering it would rewrite history. `dogfood_feedback.task_id`
   * references this table and `PRAGMA foreign_keys` is a no-op inside a transaction, so
   * enforcement is suspended before the transaction opens and integrity is verified after it
   * commits: a migration that quietly left dangling references would be worse than one that stops.
   */
  #migrateToV2(): void {
    this.#db.pragma("foreign_keys = OFF");
    try {
      this.#db.exec("BEGIN");
      try {
        this.#db.exec(runsTableSql("dogfood_runs_v2"));
        this.#db.exec(`
          INSERT INTO dogfood_runs_v2 (
            sequence, project_id, task_id, mode, predicted_complexity, predicted_risk,
            effective_complexity, effective_risk, rule_version, roles_json,
            outcome, failure_kind, reconciled, reviewer_verdict, usage_json, prior_json, observed_at
          )
          SELECT
            sequence, project_id, task_id, mode, predicted_complexity, predicted_risk,
            effective_complexity, effective_risk, rule_version, roles_json,
            outcome, NULL, 0, reviewer_verdict, usage_json, prior_json, observed_at
          FROM dogfood_runs;
          DROP TABLE dogfood_runs;
          ALTER TABLE dogfood_runs_v2 RENAME TO dogfood_runs;
        `);
        this.#db.exec(runsTriggersSql("dogfood_runs"));
        this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.#db.pragma("foreign_keys = ON");
    }
    const violations = this.#db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) throw new BrainGateInvariantError("DOGFOOD_MIGRATION_FAILED", `Dogfood migration left ${violations.length} foreign key violation(s); the corpus must be inspected before BrainGate writes to it again.`);
  }
}
