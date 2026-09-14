/**
 * The session banner.
 *
 * BrainGate's whole thesis is one picture: a request arrives, passes through a gate that
 * decides, and reaches a worker. The banner draws exactly that and nothing else — the wordmark
 * with a rail beside it, then the routing line sweeping left to right once.
 *
 * It is deliberately short. A banner that takes a noticeable moment is a banner you resent by
 * the tenth run, so the whole reveal is under half a second and every frame is a complete,
 * legible picture rather than a partial one.
 */

const WORDMARK = "BRAINGATE";
const RAIL = "▌";
const GATE = "◈";
/** The routing line the sweep animates along: request · · · gate · · · worker. */
const TRACK_WIDTH = 9;

export interface BannerStyle {
  readonly dim: string;
  readonly bright: string;
  readonly accent: string;
  readonly reset: string;
}

/** Colour is opt-out, not opt-in, so the banner still reads on a plain terminal. */
export const PLAIN: BannerStyle = Object.freeze({ dim: "", bright: "", accent: "", reset: "" });
export const COLOURED: BannerStyle = Object.freeze({
  dim: "[2m",
  bright: "[1m",
  accent: "[36m",
  reset: "[0m",
});

function trackAt(position: number): string {
  // The mark travels the track, passes through the gate at the midpoint, and exits.
  const middle = Math.floor(TRACK_WIDTH / 2);
  const cells: string[] = [];
  for (let index = 0; index < TRACK_WIDTH; index += 1) {
    if (index === middle) { cells.push(position === middle ? GATE : GATE); continue; }
    cells.push(index === position ? "▸" : "·");
  }
  return cells.join(" ");
}

/**
 * Every frame of the banner, in order, each one a complete picture.
 *
 * Returned rather than written so the shape can be asserted without a terminal, and so a
 * caller that does not want animation can simply render the last frame.
 */
export function bannerFrames(style: BannerStyle = PLAIN): readonly string[] {
  const frames: string[] = [];

  // The wordmark reveals a letter at a time, the rail already in place.
  for (let length = 1; length <= WORDMARK.length; length += 1) {
    const shown = WORDMARK.slice(0, length).split("").join(" ");
    frames.push(`  ${style.accent}${RAIL}${style.reset}  ${style.bright}${shown}${style.reset}`);
  }

  // Then the routing line sweeps once, under the finished wordmark.
  const full = WORDMARK.split("").join(" ");
  for (let position = 0; position < TRACK_WIDTH; position += 1) {
    frames.push([
      `  ${style.accent}${RAIL}${style.reset}  ${style.bright}${full}${style.reset}`,
      `  ${style.accent}${RAIL}${style.reset}  ${style.dim}${trackAt(position)}${style.reset}`,
    ].join("\n"));
  }

  // It settles on the claim the picture just made.
  frames.push([
    `  ${style.accent}${RAIL}${style.reset}  ${style.bright}${full}${style.reset}`,
    `  ${style.accent}${RAIL}${style.reset}  ${style.dim}${trackAt(-1)}${style.reset}`,
    `  ${style.accent}${RAIL}${style.reset}  ${style.dim}${TAGLINE}${style.reset}`,
  ].join("\n"));

  return Object.freeze(frames);
}

/**
 * What the banner claims about the product, in one line.
 *
 * It described routing for a long time — "route each task to the cheapest worker that can do it" —
 * and routing alone stopped being the point at M20. What the operator now gets is one conversation
 * and one goal across several native CLIs, with the workers swappable and the context carried
 * between them. Cheapest-capable routing is still there; it is a means, not the claim.
 *
 * Kept to what is implemented: no council, no automatic second opinions, nothing about the dashboard.
 */
export const TAGLINE = "one goal, many native CLIs — the worker is swappable";

/** The finished picture, for terminals that should not or cannot animate. */
export function bannerStill(style: BannerStyle = PLAIN): string {
  const frames = bannerFrames(style);
  return frames[frames.length - 1]!;
}

export interface BannerOptions {
  readonly write: (text: string) => void;
  readonly style?: BannerStyle;
  /** Draw the final frame immediately. Set when the terminal cannot redraw, or on request. */
  readonly still?: boolean;
  readonly frameMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Draws the banner, redrawing in place so it occupies its final height throughout and the
 * lines below it never jump.
 */
export async function renderBanner(options: BannerOptions): Promise<void> {
  const style = options.style ?? PLAIN;
  const write = options.write;

  if (options.still === true) {
    write(`\n${bannerStill(style)}\n\n`);
    return;
  }

  const frameMs = options.frameMs ?? 26;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const frames = bannerFrames(style);

  write("\n");
  let previousLines = 0;
  for (const frame of frames) {
    // Move back over what the last frame drew, then clear forward, so frames replace rather
    // than accumulate. Nothing is assumed about the frame heights: they are counted.
    if (previousLines > 0) write(`[${String(previousLines)}A[0J`);
    write(`${frame}\n`);
    previousLines = frame.split("\n").length;
    await sleep(frameMs);
  }
  write("\n");
}
