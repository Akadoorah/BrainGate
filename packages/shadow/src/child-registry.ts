import type { ChildProcess } from "node:child_process";

/**
 * Provider child processes this BrainGate process started and has not finished with.
 *
 * A terminal Ctrl-C reaches the whole foreground process group, so a provider child usually dies
 * on its own. A signal sent to BrainGate alone — `kill <pid>`, a script, a supervisor — does not,
 * and a provider left running while BrainGate exits is a call still spending a subscription with
 * nobody recording it. So every child is registered here and killed by the termination path.
 */

const children = new Set<ChildProcess>();

export function trackChild(child: ChildProcess): () => void {
  children.add(child);
  return () => { children.delete(child); };
}

export function trackedChildCount(): number {
  return children.size;
}

/** Kills every tracked child. Returns how many were signalled; already-dead children are fine. */
export function abortTrackedChildren(): number {
  let signalled = 0;
  for (const child of [...children]) {
    children.delete(child);
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        signalled += 1;
      }
    } catch { /* the child is already gone; nothing to do and nothing to report */ }
  }
  return signalled;
}
