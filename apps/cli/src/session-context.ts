import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { conservativeTokenEstimate } from "@braingate/context";
import { redactSecrets } from "@braingate/security";

/**
 * What has already been asked and answered in the current interactive session.
 *
 * This is deliberately not memory. Project memory is durable, evidence-gated, and reaches
 * canonical status only through `memory promote`; a session turn is none of those things. It
 * exists so a follow-up like "and the other one?" resolves, and it never becomes a memory
 * record. Keeping the two apart is what stops an unverified answer from quietly acquiring the
 * standing of a verified one.
 *
 * It does now outlive the process, because closing a terminal is not the same as changing the
 * subject: coming back an hour later and having to re-explain what you were working on is the
 * difference people notice. What that costs is a file, so the thread is kept where the project's
 * own state lives, redacted before it is written, bounded to the same few turns it always was,
 * and dropped once it is old enough that a follow-up would no longer mean what it used to.
 * `/forget` deletes it.
 */

export interface SessionTurn {
  readonly request: string;
  readonly answer: string;
}

const MAX_TURNS = 6;
const MAX_ANSWER_CHARS = 1_200;

/**
 * How long a thread still means what it meant.
 *
 * Long enough to survive lunch, a rebuild, or a closed laptop lid; short enough that yesterday's
 * "and the other one?" does not resolve against a question nobody remembers asking.
 */
const THREAD_LIFETIME_MS = 8 * 60 * 60 * 1000;

interface StoredThread {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly turns: readonly SessionTurn[];
}

/** Where a project's thread is kept: with the project's own state, never in a shared place. */
export function sessionThreadPath(storageDir: string): string {
  return join(storageDir, "session", "thread.json");
}

export class SessionContext {
  #turns: SessionTurn[] = [];
  #resumedCount = 0;
  readonly #path: string | null;
  readonly #now: () => number;

  /**
   * @param options.path Where to keep the thread. Omitted, the session lives and dies in memory,
   * which is what a test or a one-shot command wants.
   */
  constructor(options: { readonly path?: string; readonly now?: () => number } = {}) {
    this.#path = options.path ?? null;
    this.#now = options.now ?? (() => Date.now());
    this.#load();
    this.#resumedCount = this.#turns.length;
  }

  #load(): void {
    if (this.#path === null) return;
    let raw: string;
    try { raw = readFileSync(this.#path, "utf8"); }
    catch { return; }
    let stored: StoredThread;
    try { stored = JSON.parse(raw) as StoredThread; }
    catch { return; }
    // An unreadable or expired thread is no thread, never an error: a session that refused to
    // start because a file was corrupt would be worse than one that starts fresh.
    if (stored.schemaVersion !== 1 || !Array.isArray(stored.turns)) return;
    const updated = Date.parse(stored.updatedAt);
    if (!Number.isFinite(updated) || this.#now() - updated > THREAD_LIFETIME_MS) return;
    this.#turns = stored.turns
      .filter((turn): turn is SessionTurn => typeof turn?.request === "string" && typeof turn?.answer === "string")
      .slice(-MAX_TURNS)
      .map((turn) => Object.freeze({ request: turn.request, answer: turn.answer }));
  }

  #save(): void {
    if (this.#path === null) return;
    const body: StoredThread = { schemaVersion: 1, updatedAt: new Date(this.#now()).toISOString(), turns: this.#turns };
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      writeFileSync(this.#path, JSON.stringify(body), { encoding: "utf8", mode: 0o600 });
    } catch { /* a thread that cannot be kept is still a working session */ }
  }

  /** How many turns were carried over from a previous run of the terminal. */
  get resumed(): number {
    return this.#resumedCount;
  }

  /**
   * Records one completed exchange.
   *
   * Answers are truncated because a session carries the thread of the conversation, not its
   * transcript: the useful part of a follow-up is what was asked and roughly what came back.
   * Only the most recent turns are kept, so a long session does not grow without bound.
   */
  record(request: string, answer: string): void {
    const trimmed = answer.trim();
    if (request.trim().length === 0 || trimmed.length === 0) return;
    // Redacted before it is kept, not before it is shown: a thread that outlives the process is
    // a file, and a file is the one place a secret in an answer would settle.
    const safeRequest = redactSecrets(request.trim());
    const safeAnswer = redactSecrets(trimmed);
    this.#turns.push(Object.freeze({
      request: safeRequest,
      answer: safeAnswer.length > MAX_ANSWER_CHARS ? `${safeAnswer.slice(0, MAX_ANSWER_CHARS)}…` : safeAnswer,
    }));
    if (this.#turns.length > MAX_TURNS) this.#turns = this.#turns.slice(-MAX_TURNS);
    this.#save();
  }

  /** Drops everything, here and on disk. `/forget` exists so a session can be steered off a wrong thread. */
  clear(): void {
    this.#turns = [];
    if (this.#path !== null) { try { rmSync(this.#path, { force: true }); } catch { /* already gone */ } }
  }

  get size(): number {
    return this.#turns.length;
  }

  /**
   * The turns that fit within a token ceiling, most recent first in priority.
   *
   * The ceiling is a share of the task's own context budget, matching how project memory is
   * bounded, so the two together cannot crowd out the task itself. Older turns are dropped
   * before newer ones, because the nearest turn is what a follow-up usually refers to.
   */
  recent(contextTokenBudget: number): readonly SessionTurn[] {
    if (this.#turns.length === 0) return Object.freeze([]);
    const ceiling = Math.max(256, Math.floor(contextTokenBudget * 0.15));

    // The most recent turn is admitted before the ceiling is applied. A follow-up almost always
    // refers to it, so dropping it would leave the thread broken in exactly the case the thread
    // exists for. Answers are already capped when recorded, so the overshoot is bounded and
    // small; losing the whole thread on a tight budget is the worse outcome.
    const kept: SessionTurn[] = [this.#turns[this.#turns.length - 1]!];
    let spent = conservativeTokenEstimate(`${kept[0]!.request}${kept[0]!.answer}`);

    for (let index = this.#turns.length - 2; index >= 0; index -= 1) {
      const turn = this.#turns[index]!;
      const cost = conservativeTokenEstimate(`${turn.request}${turn.answer}`);
      if (spent + cost > ceiling) break;
      spent += cost;
      kept.unshift(turn);
    }
    return Object.freeze(kept);
  }
}
