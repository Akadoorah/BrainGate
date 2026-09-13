import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BrainGateInvariantError, assertRegisteredProject, type RegisteredProject } from "@braingate/core";
import { redactSecrets } from "@braingate/security";
import type { ProviderId } from "@braingate/providers";
import { EMPTY_GOAL_STATE, applyGoalStateUpdate } from "./goal-state.js";
import {
  CONVERSATION_STATUSES,
  GOAL_STATUSES,
  SESSION_RESUME_MODES,
  type ConversationRecord,
  type ConversationTurn,
  type Finding,
  type GoalRecord,
  type GoalState,
  type GoalStateUpdate,
  type ProviderSessionRecord,
  type ProviderSessionRef,
  type SessionResumeMode,
} from "./types.js";

/** How much of a turn is kept. Bounds the store, not the fidelity of the state derived from it. */
export const MAX_STORED_TURN_CHARS = 8_000;

/**
 * The project-local record of what the operator is working on.
 *
 * Storage decisions, and why:
 *
 * - **Project-scoped**, in the project's own `storageDir` beside `tasks.sqlite`, `memory.sqlite`
 *   and `dogfood.sqlite`. ADR 0002 makes the project id the isolation boundary and this is the
 *   most revealing data BrainGate holds, so it is the last thing that should live somewhere two
 *   projects could read across.
 * - **`goals.sqlite`, not the task ledger.** ADR 0011 keeps the ledger metadata-only and read whole
 *   by every export; goal state is neither. Giving it its own database also means the ledger's
 *   existing rows and triggers are untouched, which is what makes the M20 change additive.
 * - **Its own `PRAGMA user_version`.** `tasks.sqlite` has none, so the alternative would be
 *   inferring a schema from `table_info` forever. A new store can start out knowing what shape it
 *   is, and answering "newer than I understand" honestly instead of failing on a missing column.
 * - **Everything redacted on the way in.** The turn record holds the operator's own words and the
 *   full text of what a model answered, which is more raw material than anything else BrainGate
 *   persists. `redactSecrets` runs before the insert, so a secret in an answer cannot settle here.
 *
 * It is not memory. Nothing in here is canonical, nothing is retrieved as project truth, and
 * nothing reaches `ProjectMemory` except through the existing proposal gate. Keeping that line
 * visible is what stops an unverified answer acquiring the standing of a verified one.
 */
export const GOALS_SCHEMA_VERSION = 1;

interface ConversationRow {
  conversation_id: string;
  project_id: string;
  title: string;
  status: string;
  active_goal_id: string | null;
  created_at: string;
  updated_at: string;
}

interface GoalRow {
  goal_id: string;
  conversation_id: string;
  project_id: string;
  objective: string;
  status: string;
  state_json: string;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  sequence: number;
  conversation_id: string;
  project_id: string;
  goal_id: string | null;
  task_id: string | null;
  request: string;
  answer: string;
  attributed_to_json: string;
  occurred_at: string;
}

interface SessionRow {
  project_id: string;
  provider_id: string;
  model_id: string | null;
  session_id: string;
  quota_pool: string | null;
  resume_mode: string;
  goal_id: string | null;
  conversation_id: string | null;
  recorded_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function bounded(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > MAX_STORED_TURN_CHARS ? `${redacted.slice(0, MAX_STORED_TURN_CHARS)}…` : redacted;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { return null; }
}

/** Rebuilds state from its own JSON, refusing anything that is not the shape this version writes. */
function parseState(value: string): GoalState {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null) return EMPTY_GOAL_STATE;
  const raw = parsed as Partial<GoalState>;
  if (!GOAL_STATUSES.includes(raw.status as never)) return EMPTY_GOAL_STATE;
  const findings = (items: unknown): readonly Finding[] =>
    Array.isArray(items) ? Object.freeze(items.filter((item): item is Finding => typeof item === "object" && item !== null && typeof (item as Finding).claim === "string")) : Object.freeze([]);
  const strings = (items: unknown): readonly string[] =>
    Array.isArray(items) ? Object.freeze(items.filter((item): item is string => typeof item === "string")) : Object.freeze([]);
  return Object.freeze({
    status: raw.status as GoalState["status"],
    acceptedFindings: findings(raw.acceptedFindings),
    secondaryFindings: findings(raw.secondaryFindings),
    disputedFindings: findings(raw.disputedFindings),
    openQuestions: strings(raw.openQuestions),
    approvedScope: strings(raw.approvedScope),
    filesChanged: strings(raw.filesChanged),
    testsRun: strings(raw.testsRun),
    nextAction: typeof raw.nextAction === "string" ? raw.nextAction : null,
    providerSessions: Object.freeze(Array.isArray(raw.providerSessions)
      ? raw.providerSessions.filter((item): item is ProviderSessionRef => typeof item === "object" && item !== null && typeof (item as ProviderSessionRef).sessionId === "string")
      : []),
  });
}

function mapConversation(row: ConversationRow): ConversationRecord {
  return Object.freeze({
    conversationId: row.conversation_id,
    projectId: row.project_id,
    title: row.title,
    status: row.status as ConversationRecord["status"],
    activeGoalId: row.active_goal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapGoal(row: GoalRow): GoalRecord {
  return Object.freeze({
    goalId: row.goal_id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    objective: row.objective,
    state: parseState(row.state_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class GoalStore {
  readonly #project: RegisteredProject;
  readonly #db: Database.Database;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly databasePath: string;

  constructor(project: RegisteredProject, options: { readonly now?: () => string; readonly newId?: () => string } = {}) {
    assertRegisteredProject(project);
    this.#project = project;
    this.#now = options.now ?? nowIso;
    this.#newId = options.newId ?? randomUUID;
    mkdirSync(project.storageDir, { recursive: true, mode: 0o700 });
    this.databasePath = join(project.storageDir, "goals.sqlite");
    this.#db = new Database(this.databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  // ---------------------------------------------------------------- conversations

  /**
   * The conversation to continue, or a new one.
   *
   * One conversation per project for now, and the signature says so: M20's target is that a
   * follow-up continues the same goal by default, and a second conversation is a UX decision
   * (tabs? `/new`?) that this milestone deliberately does not make. Resuming the *newest* active
   * conversation is what makes closing the terminal not the same as changing the subject.
   */
  openConversation(input: { readonly title?: string } = {}): ConversationRecord {
    const existing = this.#db.prepare(
      "SELECT * FROM conversations WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC, conversation_id DESC LIMIT 1",
    ).get(this.#project.projectId) as ConversationRow | undefined;
    if (existing !== undefined) return mapConversation(existing);

    const conversationId = this.#newId();
    const timestamp = this.#now();
    this.#db.prepare(`
      INSERT INTO conversations (conversation_id, project_id, title, status, active_goal_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', NULL, ?, ?)
    `).run(conversationId, this.#project.projectId, bounded(input.title ?? "session"), timestamp, timestamp);
    return mapConversation(this.#requireConversationRow(conversationId));
  }

  getConversation(conversationId: string): ConversationRecord | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM conversations WHERE conversation_id = ? AND project_id = ?",
    ).get(conversationId, this.#project.projectId) as ConversationRow | undefined;
    return row === undefined ? undefined : mapConversation(row);
  }

  /** The conversation later turns belong to, or `null` in a project that has never had one. */
  activeConversation(): ConversationRecord | null {
    const row = this.#db.prepare(
      "SELECT * FROM conversations WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC, conversation_id DESC LIMIT 1",
    ).get(this.#project.projectId) as ConversationRow | undefined;
    return row === undefined ? null : mapConversation(row);
  }

  // ---------------------------------------------------------------- goals

  createGoal(input: { readonly conversationId: string; readonly objective: string }): GoalRecord {
    const conversation = this.getConversation(input.conversationId);
    if (conversation === undefined) {
      throw new BrainGateInvariantError("GOAL_CONVERSATION_NOT_FOUND", `Conversation ${input.conversationId} does not exist in project ${this.#project.projectId}.`);
    }
    const objective = bounded(input.objective).trim();
    if (objective.length === 0) {
      throw new BrainGateInvariantError("GOAL_OBJECTIVE_INVALID", "A goal needs a non-empty objective.");
    }
    const goalId = this.#newId();
    const timestamp = this.#now();
    const transaction = this.#db.transaction(() => {
      this.#db.prepare(`
        INSERT INTO goals (goal_id, conversation_id, project_id, objective, status, state_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(goalId, input.conversationId, this.#project.projectId, objective, EMPTY_GOAL_STATE.status, JSON.stringify(EMPTY_GOAL_STATE), timestamp, timestamp);
      this.#db.prepare("UPDATE conversations SET active_goal_id = ?, updated_at = ? WHERE conversation_id = ? AND project_id = ?")
        .run(goalId, timestamp, input.conversationId, this.#project.projectId);
      this.#db.prepare(`
        INSERT INTO goal_events (goal_id, conversation_id, project_id, kind, payload_json, occurred_at)
        VALUES (?, ?, ?, 'goal.created', ?, ?)
      `).run(goalId, input.conversationId, this.#project.projectId, JSON.stringify({ objective }), timestamp);
    });
    transaction();
    return this.requireGoal(goalId);
  }

  /** The goal a follow-up continues, or `null` before the first one exists. */
  activeGoal(conversationId?: string): GoalRecord | null {
    const conversation = conversationId === undefined ? this.activeConversation() : this.getConversation(conversationId);
    if (conversation === null || conversation === undefined) return null;
    if (conversation.activeGoalId === null) return null;
    return this.getGoal(conversation.activeGoalId) ?? null;
  }

  /**
   * The goal a request continues, creating one when there is nothing to continue.
   *
   * The condition is the M20 behaviour in one function. A conversation with a current goal
   * continues it. A conversation whose goal was closed, abandoned or finished starts a new one
   * from this request, because continuing a finished goal is the other way a short follow-up gets
   * misrouted: the work is new and the inherited floor belongs to work that is over.
   */
  continueOrCreateGoal(input: { readonly conversationId: string; readonly request: string; readonly goalId?: string | null }): GoalRecord {
    const conversation = this.getConversation(input.conversationId);
    if (conversation === undefined) {
      throw new BrainGateInvariantError("GOAL_CONVERSATION_NOT_FOUND", `Conversation ${input.conversationId} does not exist in project ${this.#project.projectId}.`);
    }
    // The caller may name the goal it believes it is continuing. It still comes from the database,
    // so a session holding a stale copy cannot continue a goal that has since been changed or
    // closed — the read is what decides, and the caller's id only chooses which row to read.
    const selected = input.goalId ?? conversation.activeGoalId;
    const current = selected === null ? null : this.getGoal(selected);
    if (current !== null && current !== undefined && current.state.status !== "done" && current.state.status !== "abandoned") return current;
    return this.createGoal({ conversationId: input.conversationId, objective: input.request });
  }

  getGoal(goalId: string): GoalRecord | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM goals WHERE goal_id = ? AND project_id = ?",
    ).get(goalId, this.#project.projectId) as GoalRow | undefined;
    return row === undefined ? undefined : mapGoal(row);
  }

  requireGoal(goalId: string): GoalRecord {
    const goal = this.getGoal(goalId);
    if (goal === undefined) {
      throw new BrainGateInvariantError("GOAL_NOT_FOUND", `Goal ${goalId} does not exist in project ${this.#project.projectId}.`);
    }
    return goal;
  }

  listGoals(conversationId?: string): readonly GoalRecord[] {
    const rows = conversationId === undefined
      ? this.#db.prepare("SELECT * FROM goals WHERE project_id = ? ORDER BY created_at ASC, goal_id ASC").all(this.#project.projectId) as GoalRow[]
      : this.#db.prepare("SELECT * FROM goals WHERE project_id = ? AND conversation_id = ? ORDER BY created_at ASC, goal_id ASC").all(this.#project.projectId, conversationId) as GoalRow[];
    return Object.freeze(rows.map(mapGoal));
  }

  /**
   * Folds an update into a goal's state.
   *
   * The only write path to accepted state, and it goes through `applyGoalStateUpdate`, so a worker
   * cannot reach in and replace a finding. Idempotent by content: re-applying the same update
   * changes nothing, because the fold only adds findings whose subject is not already established.
   */
  updateGoalState(goalId: string, update: GoalStateUpdate): GoalRecord {
    const goal = this.requireGoal(goalId);
    const next = applyGoalStateUpdate({
      current: goal.state,
      update,
      findingId: () => this.#newId(),
      recordedAt: this.#now(),
    });
    const timestamp = this.#now();
    const transaction = this.#db.transaction(() => {
      this.#db.prepare("UPDATE goals SET status = ?, state_json = ?, updated_at = ? WHERE goal_id = ? AND project_id = ?")
        .run(next.status, JSON.stringify(next), timestamp, goalId, this.#project.projectId);
      this.#db.prepare(`
        INSERT INTO goal_events (goal_id, conversation_id, project_id, kind, payload_json, occurred_at)
        VALUES (?, ?, ?, 'goal.state_updated', ?, ?)
      `).run(goalId, goal.conversationId, this.#project.projectId, JSON.stringify({
        status: next.status,
        accepted: next.acceptedFindings.length,
        secondary: next.secondaryFindings.length,
        disputed: next.disputedFindings.length,
        assertedBy: update.assertedBy ?? "unknown",
      }), timestamp);
    });
    transaction();
    return this.requireGoal(goalId);
  }

  setGoalStatus(goalId: string, status: GoalState["status"]): GoalRecord {
    return this.updateGoalState(goalId, { status });
  }

  // ---------------------------------------------------------------- the timeline

  recordTurn(input: {
    readonly conversationId: string;
    readonly goalId?: string | null;
    readonly taskId?: string | null;
    readonly request: string;
    readonly answer: string;
    readonly attributedTo?: readonly string[];
  }): ConversationTurn {
    if (this.getConversation(input.conversationId) === undefined) {
      throw new BrainGateInvariantError("GOAL_CONVERSATION_NOT_FOUND", `Conversation ${input.conversationId} does not exist in project ${this.#project.projectId}.`);
    }
    const requested = bounded(input.request).trim();
    const answered = bounded(input.answer).trim();
    if (requested.length === 0 || answered.length === 0) {
      throw new BrainGateInvariantError("GOAL_TURN_INVALID", "A conversation turn needs both a request and an answer.");
    }
    const timestamp = this.#now();
    const transaction = this.#db.transaction(() => {
      this.#db.prepare(`
        INSERT INTO conversation_turns (conversation_id, project_id, goal_id, task_id, request, answer, attributed_to_json, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.conversationId,
        this.#project.projectId,
        input.goalId ?? null,
        input.taskId ?? null,
        requested,
        answered,
        JSON.stringify([...(input.attributedTo ?? [])].slice(0, 8)),
        timestamp,
      );
      this.#db.prepare("UPDATE conversations SET updated_at = ? WHERE conversation_id = ? AND project_id = ?")
        .run(timestamp, input.conversationId, this.#project.projectId);
    });
    transaction();
    return this.recentTurns(input.conversationId, 1)[0]!;
  }

  /** The tail of the timeline, oldest first, so a caller gets it in reading order. */
  recentTurns(conversationId: string, limit: number): readonly ConversationTurn[] {
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = this.#db.prepare(
      "SELECT * FROM conversation_turns WHERE conversation_id = ? AND project_id = ? ORDER BY sequence DESC LIMIT ?",
    ).all(conversationId, this.#project.projectId, boundedLimit) as TurnRow[];
    return Object.freeze(rows.reverse().map((row) => Object.freeze({
      sequence: row.sequence,
      conversationId: row.conversation_id,
      projectId: row.project_id,
      goalId: row.goal_id,
      taskId: row.task_id,
      request: row.request,
      answer: row.answer,
      attributedTo: Object.freeze(Array.isArray(parseJson(row.attributed_to_json)) ? (parseJson(row.attributed_to_json) as string[]).filter((item) => typeof item === "string") : []),
      occurredAt: row.occurred_at,
    })));
  }

  /**
   * Turns that fit inside a token ceiling, most recent first in priority.
   *
   * The same shape and the same reasoning as the session thread's own budget — the newest turn is
   * admitted before the ceiling applies, because a follow-up almost always refers to it — but the
   * source here is the durable timeline rather than the eight-hour cache, so a goal resumed
   * tomorrow still has the exchange it continues.
   */
  recentTurnsWithin(conversationId: string, contextTokenBudget: number, options: { readonly maxTurns?: number } = {}): readonly { readonly request: string; readonly answer: string }[] {
    const limit = options.maxTurns ?? 6;
    const turns = this.recentTurns(conversationId, limit);
    if (turns.length === 0) return Object.freeze([]);
    const ceiling = Math.max(256, Math.floor(contextTokenBudget * 0.15));
    const kept: { request: string; answer: string }[] = [];
    let spent = 0;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]!;
      const cost = Math.ceil(Array.from(`${turn.request}${turn.answer}`).length / 2);
      if (kept.length > 0 && spent + cost > ceiling) break;
      spent += cost;
      kept.unshift({ request: turn.request, answer: turn.answer });
    }
    return Object.freeze(kept.map((turn) => Object.freeze(turn)));
  }

  // ---------------------------------------------------------------- native provider sessions

  /**
   * Records a native session id, when one was actually observed.
   *
   * `resumeMode` is required rather than defaulted, because there is no safe default: BrainGate has
   * never passed a resume flag, Claude runs `--no-session-persistence`, and no provider-assigned id
   * is read out of any CLI's output today. A caller that has not thought about whether this session
   * can be resumed should be unable to record one that claims it can.
   */
  recordProviderSession(input: {
    readonly providerId: ProviderId;
    readonly modelId?: string | null;
    readonly sessionId: string;
    readonly quotaPool?: string | null;
    readonly resumeMode: SessionResumeMode;
    readonly goalId?: string | null;
    readonly conversationId?: string | null;
  }): ProviderSessionRecord {
    if (!SESSION_RESUME_MODES.includes(input.resumeMode)) {
      throw new BrainGateInvariantError("GOAL_SESSION_RESUME_MODE_INVALID", `Unsupported session resume mode: ${String(input.resumeMode)}`);
    }
    const sessionId = input.sessionId.trim();
    if (sessionId.length === 0) {
      throw new BrainGateInvariantError("GOAL_SESSION_ID_INVALID", "A provider session needs a non-empty id.");
    }
    const goal = input.goalId == null ? null : this.requireGoal(input.goalId);
    const timestamp = this.#now();
    this.#db.prepare(`
      INSERT INTO provider_sessions (
        project_id, provider_id, model_id, session_id, quota_pool, resume_mode, goal_id, conversation_id, recorded_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, provider_id, model_id, session_id) DO UPDATE SET
        quota_pool = excluded.quota_pool,
        resume_mode = excluded.resume_mode,
        goal_id = excluded.goal_id,
        conversation_id = excluded.conversation_id,
        updated_at = excluded.updated_at
    `).run(
      this.#project.projectId,
      input.providerId,
      input.modelId ?? null,
      bounded(sessionId).slice(0, 200),
      input.quotaPool ?? null,
      input.resumeMode,
      goal?.goalId ?? null,
      input.conversationId ?? goal?.conversationId ?? null,
      timestamp,
      timestamp,
    );
    if (goal !== null) this.#attachSessionRef(goal.goalId, input.providerId, input.modelId ?? null, sessionId, input.resumeMode, timestamp);
    return Object.freeze({
      projectId: this.#project.projectId,
      providerId: input.providerId,
      modelId: input.modelId ?? null,
      sessionId,
      quotaPool: input.quotaPool ?? null,
      resumeMode: input.resumeMode,
      goalId: goal?.goalId ?? null,
      conversationId: input.conversationId ?? goal?.conversationId ?? null,
      recordedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  /** The newest session on record for one provider, or `null` when none was ever observed. */
  latestProviderSession(providerId: ProviderId, modelId?: string | null): ProviderSessionRecord | null {
    const row = modelId === undefined || modelId === null
      ? this.#db.prepare(
        "SELECT * FROM provider_sessions WHERE project_id = ? AND provider_id = ? ORDER BY updated_at DESC, session_id DESC LIMIT 1",
      ).get(this.#project.projectId, providerId) as SessionRow | undefined
      : this.#db.prepare(
        "SELECT * FROM provider_sessions WHERE project_id = ? AND provider_id = ? AND model_id = ? ORDER BY updated_at DESC, session_id DESC LIMIT 1",
      ).get(this.#project.projectId, providerId, modelId) as SessionRow | undefined;
    return row === undefined ? null : Object.freeze({
      projectId: row.project_id,
      providerId: row.provider_id as ProviderId,
      modelId: row.model_id,
      sessionId: row.session_id,
      quotaPool: row.quota_pool,
      resumeMode: row.resume_mode as SessionResumeMode,
      goalId: row.goal_id,
      conversationId: row.conversation_id,
      recordedAt: row.recorded_at,
      updatedAt: row.updated_at,
    });
  }

  // ---------------------------------------------------------------- internals

  #attachSessionRef(goalId: string, providerId: ProviderId, modelId: string | null, sessionId: string, resumeMode: SessionResumeMode, timestamp: string): void {
    const goal = this.requireGoal(goalId);
    const refs = goal.state.providerSessions.filter((ref) => ref.providerId !== providerId);
    refs.push(Object.freeze({ providerId, modelId, sessionId, resumeMode, recordedAt: timestamp }));
    const next: GoalState = Object.freeze({ ...goal.state, providerSessions: Object.freeze(refs.slice(-8)) });
    this.#db.prepare("UPDATE goals SET state_json = ?, updated_at = ? WHERE goal_id = ? AND project_id = ?")
      .run(JSON.stringify(next), timestamp, goalId, this.#project.projectId);
  }

  #requireConversationRow(conversationId: string): ConversationRow {
    const row = this.#db.prepare(
      "SELECT * FROM conversations WHERE conversation_id = ? AND project_id = ?",
    ).get(conversationId, this.#project.projectId) as ConversationRow | undefined;
    if (row === undefined) {
      throw new BrainGateInvariantError("GOAL_CONVERSATION_NOT_FOUND", `Conversation ${conversationId} does not exist in project ${this.#project.projectId}.`);
    }
    return row;
  }

  #migrate(): void {
    const version = this.#db.pragma("user_version", { simple: true }) as number;
    if (version > GOALS_SCHEMA_VERSION) {
      throw new BrainGateInvariantError(
        "GOAL_STORE_VERSION_UNSUPPORTED",
        `goals.sqlite was written by a newer BrainGate (schema ${String(version)}, this build understands ${String(GOALS_SCHEMA_VERSION)}).`,
      );
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (${CONVERSATION_STATUSES.map((value) => `'${value}'`).join(", ")})),
        active_goal_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (conversation_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS goals (
        goal_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (${GOAL_STATUSES.map((value) => `'${value}'`).join(", ")})),
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (goal_id, project_id),
        FOREIGN KEY (conversation_id, project_id) REFERENCES conversations(conversation_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS goal_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (goal_id, project_id) REFERENCES goals(goal_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_turns (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        goal_id TEXT,
        task_id TEXT,
        request TEXT NOT NULL,
        answer TEXT NOT NULL,
        attributed_to_json TEXT NOT NULL DEFAULT '[]',
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id, project_id) REFERENCES conversations(conversation_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS provider_sessions (
        project_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT,
        session_id TEXT NOT NULL,
        quota_pool TEXT,
        resume_mode TEXT NOT NULL CHECK (resume_mode IN (${SESSION_RESUME_MODES.map((value) => `'${value}'`).join(", ")})),
        goal_id TEXT,
        conversation_id TEXT,
        recorded_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, provider_id, model_id, session_id)
      );

      CREATE TRIGGER IF NOT EXISTS goal_events_no_update
      BEFORE UPDATE ON goal_events BEGIN
        SELECT RAISE(ABORT, 'goal_events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS goal_events_no_delete
      BEFORE DELETE ON goal_events BEGIN
        SELECT RAISE(ABORT, 'goal_events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS goals_identity_immutable
      BEFORE UPDATE OF goal_id, project_id, conversation_id ON goals BEGIN
        SELECT RAISE(ABORT, 'goal identity is immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS conversation_turns_no_update
      BEFORE UPDATE ON conversation_turns BEGIN
        SELECT RAISE(ABORT, 'conversation_turns are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS conversation_turns_no_delete
      BEFORE DELETE ON conversation_turns BEGIN
        SELECT RAISE(ABORT, 'conversation_turns are append-only');
      END;

      CREATE INDEX IF NOT EXISTS idx_conversations_project_updated ON conversations(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_goals_conversation_created ON goals(project_id, conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_turns_conversation_sequence ON conversation_turns(project_id, conversation_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_provider ON provider_sessions(project_id, provider_id, updated_at);
    `);
    if (version < GOALS_SCHEMA_VERSION) this.#db.pragma(`user_version = ${String(GOALS_SCHEMA_VERSION)}`);
  }
}
