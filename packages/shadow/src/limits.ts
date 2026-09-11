/**
 * The wall-clock ceiling BrainGate imposes on a single provider call.
 *
 * Exported so the number has one home. It is the basis of two derived bounds that must move with
 * it: the executors clamp every invocation to it, and reconciliation treats a task with no event
 * for a small multiple of it as dead — a task cannot legitimately be silent for longer than one
 * call, so a task silent for `STALE_CALL_MULTIPLIER` calls is not running.
 */
export const MAX_PROVIDER_CALL_MS = 20 * 60_000;

/** The default when a caller does not supply one from the task's budget. */
export const DEFAULT_PROVIDER_CALL_MS = 3 * 60_000;
