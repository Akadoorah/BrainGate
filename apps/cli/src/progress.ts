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

/**
 * Elapsed time, in the unit a person reads it in.
 *
 * Past a minute, seconds stop being a duration and become a number: "112s" is read digit by digit,
 * "1m52s" is read as a length of time. A DIRECT read on a subscription routinely runs past that,
 * so this is the common case rather than the edge one.
 */
export function elapsedLabel(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** One frame: the mark at `tick`, the label, and the time elapsed. */
export function progressFrame(label: string, tick: number, elapsedMs: number, style: ProgressStyle = PLAIN_PROGRESS): string {
  const middle = Math.floor(TRACK_WIDTH / 2);
  const position = tick % TRACK_WIDTH;
  const cells: string[] = [];
  for (let index = 0; index < TRACK_WIDTH; index += 1) {
    if (index === middle) cells.push(GATE);
    else cells.push(index === position ? "▸" : "·");
  }
  return `  ${style.accent}${RAIL}${style.reset}  ${style.dim}${cells.join(" ")}  ${label} · ${elapsedLabel(elapsedMs)}${style.reset}`;
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
  /**
   * Renames what the indicator says is happening, without restarting the clock.
   *
   * A task runs several roles on several subscriptions, and "working" describes none of them.
   * The elapsed count keeps running across the change because it measures the task, not the
   * role — a run that spends forty seconds planning and twenty reviewing took a minute.
   */
  readonly label: (text: string) => void;
}

/**
 * Starts the indicator and returns a handle that erases it.
 *
 * Nothing is drawn when the line cannot be redrawn, because a spinner that cannot erase itself
 * leaves a trail of frames in a log. `stop` is idempotent so the first byte of real output can
 * call it without the caller tracking whether it already has.
 */
export function startProgress(options: ProgressOptions): Progress {
  if (options.animate === false) return Object.freeze({ stop: () => { /* nothing was drawn */ }, label: () => { /* nothing to rename */ } });

  const style = options.style ?? PLAIN_PROGRESS;
  const now = options.now ?? (() => Date.now());
  const start = now();
  const schedule = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel = options.clearInterval ?? ((handle) => { clearInterval(handle as ReturnType<typeof setInterval>); });

  let tick = 0;
  let drawn = false;
  let stopped = false;
  let label = options.label;

  const draw = (): void => {
    if (stopped) return;
    // Erase the previous frame before drawing the next, so the line replaces rather than grows.
    options.write(`${drawn ? "\r[2K" : ""}${progressFrame(label, tick, now() - start, style)}`);
    drawn = true;
    tick += 1;
  };

  draw();
  const handle = schedule(draw, options.intervalMs ?? 120);
  handle.unref?.();

  return Object.freeze({
    label: (text: string) => { label = text; },
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancel(handle);
      if (drawn) options.write("\r[2K");
    },
  });
}
