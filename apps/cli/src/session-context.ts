import { conservativeTokenEstimate } from "@braingate/context";

/**
 * What has already been asked and answered in the current interactive session.
 *
 * This is deliberately not memory. Project memory is durable, evidence-gated, and reaches
 * canonical status only through `memory promote`; a session turn is none of those things. It
 * exists so a follow-up like "and the other one?" resolves, it lives in this process only, it
 * is never written to disk, and it never becomes a memory record. Keeping the two apart is what
 * stops an unverified answer from quietly acquiring the standing of a verified one.
 */

export interface SessionTurn {
  readonly request: string;
  readonly answer: string;
}

const MAX_TURNS = 6;
const MAX_ANSWER_CHARS = 1_200;

export class SessionContext {
  #turns: SessionTurn[] = [];

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
    this.#turns.push(Object.freeze({
      request: request.trim(),
      answer: trimmed.length > MAX_ANSWER_CHARS ? `${trimmed.slice(0, MAX_ANSWER_CHARS)}…` : trimmed,
    }));
    if (this.#turns.length > MAX_TURNS) this.#turns = this.#turns.slice(-MAX_TURNS);
  }

  /** Drops everything. `/forget` exists so a session can be steered off a wrong thread. */
  clear(): void {
    this.#turns = [];
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
