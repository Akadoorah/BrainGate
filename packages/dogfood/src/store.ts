import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  BrainGateInvariantError,
  assertRegisteredProject,
  type RegisteredProject,
  type TaskClassification,
  type TaskReceipt,
} from "@braingate/core";
import { deriveDogfoodPrior, emptyDogfoodPrior, parseTaskComplexity, parseTaskRisk, type PriorSample } from "./prior.js";
import type {
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

const OUTCOMES = new Set<DogfoodOutcome>(["success", "partial", "blocked", "failed"]);
const REVIEW_VERDICTS = new Set<Exclude<DogfoodReviewerVerdict, null>>(["approve", "request_changes", "disagree"]);
const MODES = new Set<DogfoodMode>(["ask", "write"]);
const COMPLEXITY_ORDER = ["T0", "T1", "T2", "T3", "T4"] as const;
const RISK_ORDER = ["low", "medium", "high", "critical"] as const;

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
  outcome: DogfoodOutcome;
  regression: number;
  recorded_at: string;
}

function now(): string { return new Date().toISOString(); }

function parseMode(value: unknown): DogfoodMode {
  if (typeof value !== "string" || !MODES.has(value as DogfoodMode)) throw new BrainGateInvariantError("DOGFOOD_MODE_INVALID", "Dogfood mode must be ask or write.");
  return value as DogfoodMode;
}

function parseOutcome(value: unknown): DogfoodOutcome {
  if (typeof value !== "string" || !OUTCOMES.has(value as DogfoodOutcome)) throw new BrainGateInvariantError("DOGFOOD_OUTCOME_INVALID", "Dogfood outcome must be success, partial, blocked, or failed.");
  return value as DogfoodOutcome;
}

function parseReviewerVerdict(value: unknown): DogfoodReviewerVerdict {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !REVIEW_VERDICTS.has(value as Exclude<DogfoodReviewerVerdict, null>)) throw new BrainGateInvariantError("DOGFOOD_REVIEW_INVALID", "Reviewer verdict must be approve, request_changes, disagree, or null.");
  return value as Exclude<DogfoodReviewerVerdict, null>;
}

function assertNoDeescalation(predicted: TaskClassification, effective: TaskClassification): void {
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
    if (!["primary", "reviewer", "judge"].includes(role.role) || role.providerId.trim().length === 0 || role.modelId.trim().length === 0) {
      throw new BrainGateInvariantError("DOGFOOD_ROLE_INVALID", "Dogfood roles require a valid role, providerId and modelId.");
    }
    return Object.freeze({ role: role.role, providerId: role.providerId.trim(), modelId: role.modelId.trim() });
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
    outcome: parseOutcome(row.outcome),
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

  recordRun(input: {
    readonly receipt: TaskReceipt;
    readonly mode: DogfoodMode;
    readonly predicted: TaskClassification;
    readonly effective: TaskClassification;
    readonly roles: readonly DogfoodRole[];
    readonly outcome: DogfoodOutcome;
    readonly reviewerVerdict?: DogfoodReviewerVerdict;
    readonly prior?: DogfoodPrior;
  }): DogfoodRunRecord {
    if (input.receipt.task.projectId !== this.#project.projectId) throw new BrainGateInvariantError("DOGFOOD_PROJECT_MISMATCH", "Task receipt belongs to another project.");
    const mode = parseMode(input.mode);
    assertNoDeescalation(input.predicted, input.effective);
    const roles = validateRoles(input.roles);
    const outcome = parseOutcome(input.outcome);
    const verdict = parseReviewerVerdict(input.reviewerVerdict ?? null);
    const prior = input.prior ?? emptyDogfoodPrior(mode);
    if (prior.mode !== mode) throw new BrainGateInvariantError("DOGFOOD_PRIOR_MODE_MISMATCH", "Dogfood prior mode must match the recorded run mode.");
    const usage = mapUsage(input.receipt);
    this.#db.prepare(`
      INSERT INTO dogfood_runs (
        project_id, task_id, mode, predicted_complexity, predicted_risk,
        effective_complexity, effective_risk, rule_version, roles_json,
        outcome, reviewer_verdict, usage_json, prior_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.#project.projectId,
      input.receipt.task.taskId,
      mode,
      input.predicted.complexity,
      input.predicted.risk,
      input.effective.complexity,
      input.effective.risk,
      input.predicted.ruleVersion,
      JSON.stringify(roles),
      outcome,
      verdict,
      JSON.stringify(usage),
      JSON.stringify(prior),
      now(),
    );
    return this.requireRun(input.receipt.task.taskId);
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
    const runs = new Map(this.listRuns().filter((run) => run.mode === mode).map((run) => [run.taskId, run]));
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
    const feedback = this.latestFeedback();
    const runByTask = new Map(runs.map((run) => [run.taskId, run]));
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
    const outcomes: Record<DogfoodOutcome, number> = { success: 0, partial: 0, blocked: 0, failed: 0 };
    const reviewerVerdicts: Record<"approve" | "request_changes" | "disagree" | "none", number> = { approve: 0, request_changes: 0, disagree: 0, none: 0 };
    const providers = new Map<string, { role: DogfoodRole["role"]; providerId: string; modelId: string; runs: number }>();
    for (const run of runs) {
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
      feedback: feedback.length,
      feedbackCoverage: runs.length === 0 ? 0 : Math.round((feedback.length / runs.length) * 1000) / 1000,
      exactComplexityMatches: exact,
      complexityUnderpredictions: under,
      complexityOverpredictions: over,
      regressions,
      outcomes: Object.freeze(outcomes),
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
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS dogfood_meta (
        project_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dogfood_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL CHECK (mode IN ('ask','write')),
        predicted_complexity TEXT NOT NULL CHECK (predicted_complexity IN ('T0','T1','T2','T3','T4')),
        predicted_risk TEXT NOT NULL CHECK (predicted_risk IN ('low','medium','high','critical')),
        effective_complexity TEXT NOT NULL CHECK (effective_complexity IN ('T0','T1','T2','T3','T4')),
        effective_risk TEXT NOT NULL CHECK (effective_risk IN ('low','medium','high','critical')),
        rule_version TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success','partial','blocked','failed')),
        reviewer_verdict TEXT NULL CHECK (reviewer_verdict IS NULL OR reviewer_verdict IN ('approve','request_changes','disagree')),
        usage_json TEXT NOT NULL,
        prior_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dogfood_feedback (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        actual_complexity TEXT NOT NULL CHECK (actual_complexity IN ('T0','T1','T2','T3','T4')),
        actual_risk TEXT NULL CHECK (actual_risk IS NULL OR actual_risk IN ('low','medium','high','critical')),
        outcome TEXT NOT NULL CHECK (outcome IN ('success','partial','blocked','failed')),
        regression INTEGER NOT NULL CHECK (regression IN (0,1)),
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES dogfood_runs(task_id)
      );
      CREATE TRIGGER IF NOT EXISTS dogfood_runs_no_update BEFORE UPDATE ON dogfood_runs BEGIN SELECT RAISE(ABORT, 'dogfood_runs are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS dogfood_runs_no_delete BEFORE DELETE ON dogfood_runs BEGIN SELECT RAISE(ABORT, 'dogfood_runs are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS dogfood_feedback_no_update BEFORE UPDATE ON dogfood_feedback BEGIN SELECT RAISE(ABORT, 'dogfood_feedback is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS dogfood_feedback_no_delete BEFORE DELETE ON dogfood_feedback BEGIN SELECT RAISE(ABORT, 'dogfood_feedback is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS dogfood_meta_no_update BEFORE UPDATE ON dogfood_meta BEGIN SELECT RAISE(ABORT, 'dogfood_meta is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS dogfood_meta_no_delete BEFORE DELETE ON dogfood_meta BEGIN SELECT RAISE(ABORT, 'dogfood_meta is immutable'); END;
    `);
  }
}
