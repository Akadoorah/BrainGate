/**
 * The working indicator.
 *
 * A visual task can run for minutes and a T4 audit for longer, and until now that time was
 * silent: no output, no sign the run was alive, nothing to distinguish thinking from hung.
 *
 * It reuses the banner's motif rather than inventing a second one — the same rail, the same
 * track, the same gate — so a request in flight looks like the picture the banner drew of what
 * BrainGate does. The elapsed count matters more than the motion: it is what tells you a
 * two-minute run is normal and a ten-minute one is not.
 */

const RAIL = "▌";
const GATE = "◈";
const TRACK_WIDTH = 9;

export interface ProgressStyle {
  readonly dim: string;
  readonly accent: string;
  readonly reset: string;
}

export const PLAIN_PROGRESS: ProgressStyle = Object.freeze({ dim: "", accent: "", reset: "" });
export const COLOURED_PROGRESS: ProgressStyle = Object.freeze({ dim: "[2m", accent: "[36m", reset: "[0m" });

/** One frame: the mark at `tick`, the label, and whole seconds elapsed. */
export function progressFrame(label: string, tick: number, elapsedMs: number, style: ProgressStyle = PLAIN_PROGRESS): string {
  const middle = Math.floor(TRACK_WIDTH / 2);
  const position = tick % TRACK_WIDTH;
  const cells: string[] = [];
  for (let index = 0; index < TRACK_WIDTH; index += 1) {
    if (index === middle) cells.push(GATE);
    else cells.push(index === position ? "▸" : "·");
  }
  const seconds = Math.floor(elapsedMs / 1000);
  return `  ${style.accent}${RAIL}${style.reset}  ${style.dim}${cells.join(" ")}  ${label} · ${String(seconds)}s${style.reset}`;
}

export interface ProgressOptions {
  readonly write: (text: string) => void;
  readonly label: string;
  readonly style?: ProgressStyle;
  /** False where the line cannot be redrawn: a pipe, CI, a dumb terminal. */
  readonly animate?: boolean;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  readonly clearInterval?: (handle: unknown) => void;
}

export interface Progress {
  /** Erases the indicator. Safe to call more than once, and before the first frame. */
  readonly stop: () => void;
}

/**
 * Starts the indicator and returns a handle that erases it.
 *
 * Nothing is drawn when the line cannot be redrawn, because a spinner that cannot erase itself
 * leaves a trail of frames in a log. `stop` is idempotent so the first byte of real output can
 * call it without the caller tracking whether it already has.
 */
export function startProgress(options: ProgressOptions): Progress {
  if (options.animate === false) return Object.freeze({ stop: () => { /* nothing was drawn */ } });

  const style = options.style ?? PLAIN_PROGRESS;
  const now = options.now ?? (() => Date.now());
  const start = now();
  const schedule = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel = options.clearInterval ?? ((handle) => { clearInterval(handle as ReturnType<typeof setInterval>); });

  let tick = 0;
  let drawn = false;
  let stopped = false;

  const draw = (): void => {
    if (stopped) return;
    // Erase the previous frame before drawing the next, so the line replaces rather than grows.
    options.write(`${drawn ? "\r[2K" : ""}${progressFrame(options.label, tick, now() - start, style)}`);
    drawn = true;
    tick += 1;
  };

  draw();
  const handle = schedule(draw, options.intervalMs ?? 120);
  handle.unref?.();

  return Object.freeze({
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancel(handle);
      if (drawn) options.write("\r[2K");
    },
  });
}
