/**
 * The runs this process is currently responsible for.
 *
 * A terminal signal is the one moment BrainGate knows it is about to stop being able to write
 * anything: the run in flight has spent provider calls and would otherwise leave a task stuck in
 * `running` forever (one such task has been sitting in a real project for 33 hours). So an active
 * run registers a synchronous finalizer here, and the CLI's signal handler calls it before
 * exiting.
 *
 * Handlers are synchronous by contract: `better-sqlite3` is synchronous, so a signal handler can
 * never interleave a statement or a transaction, and nothing here awaits.
 */

export type TerminationSignal = "SIGINT" | "SIGTERM";

const handlers = new Set<(signal: TerminationSignal) => void>();

export function registerActiveRun(handler: (signal: TerminationSignal) => void): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

export function activeRunCount(): number {
  return handlers.size;
}

/** Runs every registered finalizer, then clears the registry. Returns how many ran. */
export function abortActiveRuns(signal: TerminationSignal): number {
  const active = [...handlers];
  handlers.clear();
  let ran = 0;
  for (const handler of active) {
    // A finalizer that throws must not stop the others, and must not prevent the process from
    // exiting: the alternative is a stuck task and a hung terminal.
    try { handler(signal); ran += 1; }
    catch { /* recorded nowhere to record it: the process is ending */ }
  }
  return ran;
}
