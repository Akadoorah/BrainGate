import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BrainGateInvariantError } from "./errors.js";
import { assertRegisteredProject, type RegisteredProject } from "./project-registry.js";
import type { TaskComplexity, TaskRisk, TaskState } from "./task-outcome.js";

// The vocabularies live in `task-outcome.ts` as runtime lists, so a validator and the type it
// checks cannot drift apart. They are exported from the package index, not from here, so the
// barrel has exactly one source for each name.
export type UsageEvidence = "native" | "measured" | "estimated" | "unknown";

export interface CreateTaskInput {
  readonly title: string;
  readonly intent?: string;
  readonly complexity?: TaskComplexity;
  readonly risk?: TaskRisk;
  readonly route?: unknown;
  readonly memoryProposalRefs?: readonly string[];
}

export interface TaskRecord {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly state: TaskState;
  readonly intent: string | null;
  readonly complexity: TaskComplexity | null;
  readonly risk: TaskRisk | null;
  readonly route: unknown;
  readonly memoryProposalRefs: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskEvent {
  readonly sequence: number;
  readonly taskId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly fromState: TaskState | null;
  readonly toState: TaskState | null;
  readonly payload: unknown;
  readonly occurredAt: string;
}

export interface UsageRecord {
  readonly sequence: number;
  readonly taskId: string;
  readonly provider: string;
  readonly model: string | null;
  readonly evidence: UsageEvidence;
  readonly metric: string;
  readonly value: number | null;
  readonly unit: string | null;
  readonly recordedAt: string;
}

export interface TaskReceipt {
  readonly task: TaskRecord;
  readonly events: readonly TaskEvent[];
  readonly usage: readonly UsageRecord[];
}

const VALID_EVIDENCE = new Set<UsageEvidence>(["native", "measured", "estimated", "unknown"]);
const TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  created: new Set(["planned", "running", "cancelled"]),
  planned: new Set(["running", "failed", "cancelled"]),
  running: new Set(["verifying", "completed", "failed", "cancelled"]),
  verifying: new Set(["running", "completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

interface TaskRow {
  task_id: string;
  project_id: string;
  title: string;
  state: TaskState;
  intent: string | null;
  complexity: TaskComplexity | null;
  risk: TaskRisk | null;
  route_json: string | null;
  memory_proposal_refs_json: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  sequence: number;
  task_id: string;
  project_id: string;
  kind: string;
  from_state: TaskState | null;
  to_state: TaskState | null;
  payload_json: string | null;
  occurred_at: string;
}

interface UsageRow {
  sequence: number;
  task_id: string;
  provider: string;
  model: string | null;
  evidence: UsageEvidence;
  metric: string;
  value: number | null;
  unit: string | null;
  recorded_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function parseJson(value: string | null): unknown {
  return value === null ? null : (JSON.parse(value) as unknown);
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    title: row.title,
    state: row.state,
    intent: row.intent,
    complexity: row.complexity,
    risk: row.risk,
    route: parseJson(row.route_json),
    memoryProposalRefs: JSON.parse(row.memory_proposal_refs_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskLedger {
  readonly #project: RegisteredProject;
  readonly #db: Database.Database;
  readonly databasePath: string;

  constructor(project: RegisteredProject) {
    assertRegisteredProject(project);
    this.#project = project;
    mkdirSync(project.storageDir, { recursive: true });
    this.databasePath = join(project.storageDir, "tasks.sqlite");
    this.#db = new Database(this.databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new BrainGateInvariantError("TASK_TITLE_INVALID", "Task title must be non-empty.");
    }

    const taskId = randomUUID();
    const timestamp = now();
    const routeJson = input.route === undefined ? null : JSON.stringify(input.route);
    const refsJson = JSON.stringify(input.memoryProposalRefs ?? []);

    const transaction = this.#db.transaction(() => {
      this.#db.prepare(`
        INSERT INTO tasks (
          task_id, project_id, title, state, intent, complexity, risk,
          route_json, memory_proposal_refs_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        this.#project.projectId,
        title,
        input.intent ?? null,
        input.complexity ?? null,
        input.risk ?? null,
        routeJson,
        refsJson,
        timestamp,
        timestamp,
      );
      this.#insertEvent(taskId, "task.created", null, "created", { title }, timestamp);
    });
    transaction();
    return this.requireTask(taskId);
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM tasks WHERE task_id = ? AND project_id = ?",
    ).get(taskId, this.#project.projectId) as TaskRow | undefined;
    return row === undefined ? undefined : mapTask(row);
  }

  requireTask(taskId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (task === undefined) {
      throw new BrainGateInvariantError("TASK_NOT_FOUND", `Task ${taskId} does not exist in project ${this.#project.projectId}.`);
    }
    return task;
  }

  listTasks(): readonly TaskRecord[] {
    const rows = this.#db.prepare(
      "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC, task_id ASC",
    ).all(this.#project.projectId) as TaskRow[];
    return rows.map(mapTask);
  }

  transition(taskId: string, toState: TaskState, payload: unknown = null): TaskRecord {
    const current = this.requireTask(taskId);
    if (!TRANSITIONS[current.state].has(toState)) {
      throw new BrainGateInvariantError(
        "TASK_TRANSITION_INVALID",
        `Invalid task transition ${current.state} -> ${toState} for task ${taskId}.`,
      );
    }
    const timestamp = now();
    const transaction = this.#db.transaction(() => {
      const result = this.#db.prepare(
        "UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ? AND project_id = ? AND state = ?",
      ).run(toState, timestamp, taskId, this.#project.projectId, current.state);
      if (result.changes !== 1) {
        throw new BrainGateInvariantError("TASK_CONCURRENT_UPDATE", `Task ${taskId} changed during transition.`);
      }
      this.#insertEvent(taskId, "task.transition", current.state, toState, payload, timestamp);
    });
    transaction();
    return this.requireTask(taskId);
  }

  appendEvent(taskId: string, kind: string, payload: unknown = null): void {
    this.requireTask(taskId);
    if (kind.trim().length === 0) {
      throw new BrainGateInvariantError("TASK_EVENT_KIND_INVALID", "Task event kind must be non-empty.");
    }
    this.#insertEvent(taskId, kind.trim(), null, null, payload, now());
  }

  recordUsage(input: {
    taskId: string;
    provider: string;
    model?: string | null;
    evidence: UsageEvidence;
    metric: string;
    value?: number | null;
    unit?: string | null;
  }): void {
    this.requireTask(input.taskId);
    if (!VALID_EVIDENCE.has(input.evidence)) {
      throw new BrainGateInvariantError("USAGE_EVIDENCE_INVALID", `Unsupported usage evidence: ${input.evidence}`);
    }
    if (input.provider.trim().length === 0 || input.metric.trim().length === 0) {
      throw new BrainGateInvariantError("USAGE_RECORD_INVALID", "Usage provider and metric must be non-empty.");
    }
    this.#db.prepare(`
      INSERT INTO usage_records (
        task_id, project_id, provider, model, evidence, metric, value, unit, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.taskId,
      this.#project.projectId,
      input.provider.trim(),
      input.model ?? null,
      input.evidence,
      input.metric.trim(),
      input.value ?? null,
      input.unit ?? null,
      now(),
    );
  }

  receipt(taskId: string): TaskReceipt {
    const task = this.requireTask(taskId);
    const eventRows = this.#db.prepare(
      "SELECT * FROM task_events WHERE task_id = ? AND project_id = ? ORDER BY sequence ASC",
    ).all(taskId, this.#project.projectId) as EventRow[];
    const usageRows = this.#db.prepare(
      "SELECT * FROM usage_records WHERE task_id = ? AND project_id = ? ORDER BY sequence ASC",
    ).all(taskId, this.#project.projectId) as UsageRow[];

    return {
      task,
      events: eventRows.map((row) => ({
        sequence: row.sequence,
        taskId: row.task_id,
        projectId: row.project_id,
        kind: row.kind,
        fromState: row.from_state,
        toState: row.to_state,
        payload: parseJson(row.payload_json),
        occurredAt: row.occurred_at,
      })),
      usage: usageRows.map((row) => ({
        sequence: row.sequence,
        taskId: row.task_id,
        provider: row.provider,
        model: row.model,
        evidence: row.evidence,
        metric: row.metric,
        value: row.value,
        unit: row.unit,
        recordedAt: row.recorded_at,
      })),
    };
  }

  #insertEvent(
    taskId: string,
    kind: string,
    fromState: TaskState | null,
    toState: TaskState | null,
    payload: unknown,
    timestamp: string,
  ): void {
    this.#db.prepare(`
      INSERT INTO task_events (
        task_id, project_id, kind, from_state, to_state, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      this.#project.projectId,
      kind,
      fromState,
      toState,
      payload === null ? null : JSON.stringify(payload),
      timestamp,
    );
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('created', 'planned', 'running', 'verifying', 'completed', 'failed', 'cancelled')),
        intent TEXT,
        complexity TEXT CHECK (complexity IS NULL OR complexity IN ('T0', 'T1', 'T2', 'T3', 'T4')),
        risk TEXT CHECK (risk IS NULL OR risk IN ('low', 'medium', 'high', 'critical')),
        route_json TEXT,
        memory_proposal_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        payload_json TEXT,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (task_id, project_id) REFERENCES tasks(task_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS usage_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        evidence TEXT NOT NULL CHECK (evidence IN ('native', 'measured', 'estimated', 'unknown')),
        metric TEXT NOT NULL,
        value REAL,
        unit TEXT,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (task_id, project_id) REFERENCES tasks(task_id, project_id)
      );

      CREATE TRIGGER IF NOT EXISTS tasks_identity_immutable
      BEFORE UPDATE OF task_id, project_id ON tasks BEGIN
        SELECT RAISE(ABORT, 'task identity is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS task_events_no_update
      BEFORE UPDATE ON task_events BEGIN
        SELECT RAISE(ABORT, 'task_events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS task_events_no_delete
      BEFORE DELETE ON task_events BEGIN
        SELECT RAISE(ABORT, 'task_events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS usage_records_no_update
      BEFORE UPDATE ON usage_records BEGIN
        SELECT RAISE(ABORT, 'usage_records are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS usage_records_no_delete
      BEFORE DELETE ON usage_records BEGIN
        SELECT RAISE(ABORT, 'usage_records are append-only');
      END;

      CREATE INDEX IF NOT EXISTS idx_tasks_project_created ON tasks(project_id, created_at, task_id);
      CREATE INDEX IF NOT EXISTS idx_events_task_sequence ON task_events(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_usage_task_sequence ON usage_records(task_id, sequence);
    `);
  }
}
