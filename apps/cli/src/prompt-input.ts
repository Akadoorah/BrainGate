/**
 * Terminal input, with paste as a boundary rather than a race.
 *
 * The defect this replaces: a pasted request was submitted the moment the paste arrived, before the
 * operator pressed anything. It was fixed once with a 25 ms burst window, and real dogfood on a
 * multi-paragraph paste showed why that could not work — the heuristic was deciding *when the paste
 * had ended*, which is a question the terminal already answers, and the answer does not depend on how
 * fast the machine is.
 *
 * What the terminal actually sends, measured on the Node stack this ships against (Node 22, macOS):
 * with bracketed paste enabled, a paste arrives as `ESC [ 2 0 0 ~` … content … `ESC [ 2 0 1 ~`. Node's
 * readline does not expose that: with `terminal: true` it strips the markers and emits one `line`
 * event per newline inside the paste, so a pasted paragraph is indistinguishable from somebody
 * hammering Enter. That is why this module exists instead of a smarter `rl.question` — nothing above
 * the raw stream can tell the two apart, because by the time it is asked the difference is gone.
 *
 * The model is a composer:
 *
 * - typing behaves exactly as it did: characters echo, Backspace deletes, Enter submits;
 * - a bracketed paste is inserted into the draft with its newlines intact, echoed as the lines it
 *   is, and **does not submit** — including when the paste ends with a newline, which is the case
 *   that used to slip through;
 * - the next Enter submits the whole draft, once;
 * - Ctrl+C clears a draft, and ends the session when there is nothing to clear.
 *
 * Nothing here waits, sleeps or measures time. The paste boundary is a byte sequence, the submit is
 * a byte, and the state machine is a function of those two facts.
 *
 * ## The editable region, and why it is anchored by the terminal
 *
 * The composer keeps a real buffer and a cursor *index into it* (always on a grapheme boundary), and
 * renders that buffer the way a terminal would: every line as it was typed, wrapping normally, the
 * cursor placed where the operator put it. Left/Right move by grapheme, Up/Down by line (keeping the
 * column), Home/End to the ends of the line, Backspace and Delete around the cursor.
 *
 * The whole region is repainted from an anchor the **terminal** holds, not one this module counts:
 * `ESC 7` saves the cursor where the prompt ends, and every redraw is `ESC 8` (back to that exact
 * spot) + `ESC [ J` (erase from there down) + the buffer again. Two earlier designs moved the cursor
 * by a row count this module computed — first from the draft's logical line count, then from a
 * one-row window — and the first of them erased the operator's history, because the terminal decides
 * how many rows text occupies and a soft-wrapped line made the count wrong. Asking the terminal where
 * the anchor is removes the arithmetic: erasing downwards from the end of the prompt can only touch
 * rows the composer itself wrote, however the draft wrapped, however wide the characters are, and
 * however the terminal reorders bidirectional text.
 *
 * The cursor's *visual* position is still computed here, because a cursor has to be placed somewhere.
 * That arithmetic is allowed to be approximate for exotic width combinations — it can put the cursor
 * a cell off on a line of emoji — but it cannot damage anything: the worst case is a cursor drawn in
 * the wrong cell inside the region that was just reprinted, never a row of history touched.
 * Escape sequences the composer does not implement — function keys, mouse reports, bracketed-paste
 * status replies — are consumed whole and ignored, so nothing unrecognised ever reaches the buffer.
 * full redraw**, and consumes every escape sequence it does not implement rather than acting on it.
 */

/** Enables bracketed paste on the terminal. Until this is written, the markers never arrive. */
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";
/**
 * The paste markers themselves, exported because a fixture that cannot produce them cannot test
 * this module: the bug was that nothing distinguished a pasted newline from a pressed Enter, and a
 * test that hands over lines is a test of the old abstraction.
 */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

const CR = "\r";
const LF = "\n";
/**
 * The line ending this module writes to the terminal itself.
 *
 * Raw mode clears `OPOST`, and with it `ONLCR`, so a bare `LF` may advance the row without returning
 * the column to 0 — the display walks across the screen instead of down it. A `CR` written here is
 * this module positioning its own output; it is not pasted content, and pasted content never keeps
 * one (see `normalisePaste`).
 */
const NEWLINE = "\r\n";
const BACKSPACE = "\u007f";
const BACKSPACE_ALT = "\b";
const INTERRUPT = "\u0003";
const EOT = "\u0004";

/**
 * Save and restore the cursor position (DECSC/DECRC).
 *
 * The anchor is the terminal's memory, not this module's arithmetic: everything the composer erases
 * is measured from the spot the terminal itself remembers, which is why a mis-counted row can no
 * longer reach the operator's history.
 */
const SAVE_CURSOR = "\u001b7";
const RESTORE_CURSOR = "\u001b8";
/** Erase from the cursor to the end of the display, cursor unmoved. */
const ERASE_DOWN = "\u001b[J";
/** Put the cursor in a given column of the current row, 1-based. */
const column = (value: number): string => `\u001b[${String(Math.max(1, value))}G`;
/** Cursor up `rows`, for placing the cursor inside the region just reprinted. */
const cursorUp = (rows: number): string => `\u001b[${String(rows)}A`;

/**
 * Grapheme clusters. The unit a person means by "a character", and the unit Backspace deletes.
 *
 * `Intl.Segmenter` is the real implementation and the only one that agrees with the terminal about
 * combining marks, emoji, ZWJ sequences, regional indicators and their many neighbours. Where it is
 * absent the fallback below is used, and where the whole `Intl` object is absent the code-point
 * fallback inside it is used. Both keep the buffer valid — no half-surrogate is ever produced — which
 * is the property that matters: a wrong-width deletion is visible, a lone surrogate is data loss.
 */
const segmenter: Intl.Segmenter | null = (() => {
  try {
    return typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  } catch {
    return null;
  }
})();

/** Combining marks, and the variation selectors that attach to the character before them. */
const COMBINING = /^[\p{M}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;
const ZWJ = "\u200D";
const SKIN_TONE = /^\p{Emoji_Modifier}$/u;
const REGIONAL = /^\p{Regional_Indicator}$/u;
const KEYCAP = "\u20E3";

/** The last cluster of `text`, or `""`. */
export function lastGrapheme(text: string): string {
  if (text.length === 0) return "";
  if (segmenter !== null) {
    let last = "";
    for (const { segment } of segmenter.segment(text)) last = segment;
    return last;
  }
  return fallbackLastGrapheme(text);
}

/**
 * The fallback splitter: the rules a terminal actually applies, and no more.
 *
 * Deliberately not a Unicode grapheme-break implementation. It walks back over the things that attach
 * — combining marks and variation selectors, emoji modifiers, joiners, regional indicator pairs,
 * keycaps — and stops at the first code point that is none of them, which is the character's base.
 * Being wrong here deletes one visible unit too few or too many; being wrong about *where a code point
 * ends* is not possible, because every index is a code-point index and the result is always a whole
 * number of them. That distinction matters: a mis-sized deletion is visible and reversible, a lone
 * surrogate in the draft is neither.
 *
 * Exported only so it can be tested. Node always has `Intl.Segmenter`, so no test can reach this by
 * taking the other branch — and an untested fallback for the one operation that must never corrupt
 * the buffer is not a fallback. Nothing else imports it.
 */
export function fallbackLastGrapheme(text: string): string {
  const points = Array.from(text);
  const last = points.length - 1;
  if (last < 0) return "";

  /** What a character can be made of, without being a base in its own right. */
  const attaches = (point: string): boolean =>
    point === ZWJ || point === KEYCAP || COMBINING.test(point) || SKIN_TONE.test(point);

  /** Whether this can start a character, so that walking back stops here. */
  const isBase = (point: string): boolean => !attaches(point) && !REGIONAL.test(point);

  /** Where the character that ends at `from` begins. */
  const startOf = (from: number): number => {
    let index = from;
    for (;;) {
      const point = points[index];
      const previous = points[index - 1];
      if (point === undefined) return 0;
      if (previous === undefined) return index;
      // Marks and modifiers extend whatever precedes them; a joiner extends both ways.
      if (attaches(point) || point === ZWJ) { index -= 1; continue; }
      // A regional indicator pairs with the one before it, and only in pairs. Not a base: an odd
      // number of them ending here means the pair started one further back.
      if (REGIONAL.test(point) && REGIONAL.test(previous)) { index -= 1; continue; }
      if (isBase(previous)) return index;
      // The previous code point is a modifier with its own base behind it — `e` in `e` + combining
      // acute — so this character started even earlier.
      index = startOf(index - 1);
    }
  };

  // A mark or modifier at the end means the whole cluster goes: deleting a keycap deletes the digit
  // under it, and deleting a fatha deletes the letter.
  const start = attaches(points[last]!) ? startOf(last - 1) : startOf(last);
  return points.slice(start).join("");
}

/** The input side of a terminal: what this needs of `process.stdin`, and of a test's fixture. */
export interface PromptInputSource {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  off?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  setRawMode?(mode: boolean): unknown;
  readonly isTTY?: boolean;
}

export interface PromptInputOptions {
  readonly input: PromptInputSource;
  readonly write: (text: string) => void;
  /**
   * Whether this is a terminal: raw mode, echo and bracketed paste are only meaningful there.
   *
   * A pipe is not a terminal and has no paste markers, so it keeps the line semantics it always had
   * — one Enter, one line — and the composer does not pretend to edit anything.
   */
  readonly terminal?: boolean;
  /** The marker shown when a paste lands, so a pending multiline draft is visible as one. */
  readonly continuation?: string;
  /**
   * How wide the terminal is, for deciding how much of the draft fits on its one row.
   *
   * Injected so a test can pin it, read from the terminal otherwise. The module only ever uses it to
   * show *less*: it never wraps text itself, because a row this code wrapped is a row whose height it
   * would then have to count — the arithmetic that corrupted history.
   */
  readonly columns?: number;
}

export interface PromptInput {
  /** Writes the question and resolves with one submitted answer, or `null` when input ends. */
  readonly ask: (question: string) => Promise<string | null>;
  /** Resolves once every byte delivered so far has been processed. For tests; never waits on a clock. */
  readonly idle: () => Promise<void>;
  /** Restores the terminal: raw mode off, bracketed paste off. */
  readonly close: () => void;
}

/**
 * The longest suffix of `text` that could still become `marker` with more bytes.
 *
 * Needed because a chunk boundary can fall inside an escape sequence — the marker is seven bytes and
 * a terminal is free to split them. Holding back a partial prefix is what makes the parse a function
 * of the byte stream rather than of how the kernel happened to chunk it.
 */
function partialMarkerPrefix(text: string, marker: string): string {
  const max = Math.min(text.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) return text.slice(text.length - length);
  }
  return "";
}

/**
 * How many cells one grapheme occupies, as far as this module needs to know.
 *
 * Correct for the cases a person can see: zero for combining marks and joiners, two for the East
 * Asian wide and emoji ranges, one otherwise. A cursor placed with this is right for English, Arabic
 * and emoji; where it is wrong — an unusual width table, a terminal that renders a sequence as one
 * glyph — the cursor may sit a cell away from the ideal spot inside the region that was just
 * reprinted. It cannot touch anything else, because the region's bounds come from the terminal.
 */
function cellWidth(character: string): number {
  if (character.length === 0) return 0;
  if (COMBINING.test(character) || character === ZWJ || SKIN_TONE.test(character)) return 0;
  if (/^[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u.test(character)) return 0;
  const point = character.codePointAt(0) ?? 0;
  // East Asian Wide and Fullwidth, and the emoji planes: two cells.
  if (
    (point >= 0x1100 && point <= 0x115f) || (point >= 0x2e80 && point <= 0x303e) ||
    (point >= 0x3041 && point <= 0x33ff) || (point >= 0x3400 && point <= 0x4dbf) ||
    (point >= 0x4e00 && point <= 0x9fff) || (point >= 0xa000 && point <= 0xa4cf) ||
    (point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe30 && point <= 0xfe6f) || (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) || (point >= 0x1f300 && point <= 0x1faff) ||
    (point >= 0x20000 && point <= 0x3fffd)
  ) return 2;
  // A regional indicator is half of a flag; the pair is two cells, so one each.
  if (REGIONAL.test(character)) return 1;
  return 1;
}

/** The grapheme clusters of `text`, in order. */
export function graphemes(text: string): readonly string[] {
  if (segmenter !== null) return [...segmenter.segment(text)].map((part) => part.segment);
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const next = fallbackFirstGrapheme(rest);
    if (next.length === 0) break;
    parts.push(next);
    rest = rest.slice(next.length);
  }
  return parts;
}

/** The width of a whole string, in the cells its graphemes occupy. */
export function displayWidth(text: string): number {
  let total = 0;
  for (const character of graphemes(text)) total += cellWidth(character);
  return total;
}

/**
 * The first grapheme of `text`, for the fallback splitter.
 *
 * The mirror of `fallbackLastGrapheme`: take one base, then everything that attaches to it. It exists
 * so the fallback path can split forwards as well as backwards with the same rules, rather than
 * growing a second, differently-wrong notion of where a character ends.
 */
export function fallbackFirstGrapheme(text: string): string {
  const points = Array.from(text);
  if (points.length === 0) return "";
  const first = points[0]!;
  if (first === ZWJ) return first;
  let index = 1;
  const attaches = (point: string): boolean =>
    point === ZWJ || point === KEYCAP || COMBINING.test(point) || SKIN_TONE.test(point);
  while (index < points.length && attaches(points[index]!)) {
    const point = points[index]!;
    index += 1;
    // A joiner pulls in the character after it: an emoji ZWJ sequence is one grapheme.
    if (point === ZWJ && index < points.length) index += 1;
  }
  return points.slice(0, index).join("");
}

interface Position {
  /** Which rendered row of the region the cursor is on, 0-based. */
  readonly row: number;
  /** How many cells into that row, 0-based. */
  readonly column: number;
  /** How many rows the whole draft occupies once wrapped. */
  readonly rows: number;
}

/**
 * Where the cursor sits in the rendered draft, and how tall the draft is.
 *
 * Computed from the buffer, the cursor index and the terminal's width — never from what is on
 * screen. The renderer prints the draft and then moves to this position, so a wrong answer here is a
 * cursor in the wrong cell of the region that was just reprinted; it is never able to reach a row the
 * composer did not write, because the region's bounds come from the terminal's own saved position.
 */
export function cursorPosition(draft: string, cursor: number, columns: number): Position {
  const width = columns > 0 ? columns : 80;
  const lines = draft.split(LF);
  const before = draft.slice(0, cursor);
  const consumed = before.split(LF);
  const cursorLine = consumed.length - 1;
  const columnCells = displayWidth(consumed[cursorLine] ?? "");
  const rowsFor = (text: string): number => Math.max(1, Math.ceil(displayWidth(text) / width));
  let rows = 0;
  let row = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const height = rowsFor(lines[index] ?? "");
    if (index < cursorLine) row += height;
    rows += height;
  }
  row += Math.floor(columnCells / width);
  return Object.freeze({ row, column: columnCells % width, rows });
}

/**
 * Paste content, with its line endings normalised and nothing else touched.
 *
 * A terminal is free to send CR for a pasted newline — macOS Terminal does — and a CR left in the
 * stored request is not a cosmetic problem: every renderer that follows honours it, so the cursor
 * returns to column 0 and the next line is written *over* the previous one. Real dogfood stored a
 * goal objective containing `\r\r` where its blank lines were, and `/goal` displayed a spliced
 * sentence that never existed in what was pasted.
 *
 * So the normalisation happens here, once, on the way in: CRLF and lone CR become LF. Everything
 * else — blank lines, numbered lists, punctuation, a trailing newline — is kept exactly, because the
 * draft that is submitted has to be the text that was pasted.
 */
const normalisePaste = (text: string): string => text.replace(/\r\n?/g, LF);

export function createPromptInput(options: PromptInputOptions): PromptInput {
  const terminal = options.terminal ?? options.input.isTTY === true;

  /** The draft: the whole editable buffer, exactly what will be submitted. */
  let draft = "";
  /** Where editing happens, as a UTF-16 index into `draft`, always on a grapheme boundary. */
  let cursor = 0;
  /** The question of the ask currently waiting, or `null` between asks. */
  let prompt: string | null = null;
  let waiter: ((answer: string | null) => void) | null = null;
  /** Bytes not yet parsed: an incomplete escape sequence, or a paste that has not ended. */
  let pending = "";
  /** Inside a bracketed paste. Newlines in here are content, and the end marker is not a submit. */
  let pasting = false;
  let closed = false;

  const write = options.write;
  const submitted: string[] = [];

  /** How wide the terminal is now. Re-read on every render, so a resize is picked up by the next key. */
  const terminalWidth = (): number => {
    const value = options.columns ?? process.stdout.columns ?? 80;
    return Number.isFinite(value) && value > 8 ? Math.floor(value) : 80;
  };

  const deliver = (answer: string): void => {
    if (waiter === null) { submitted.push(answer); return; }
    const resolve = waiter;
    waiter = null;
    prompt = null;
    resolve(answer);
  };

  const endSession = (): void => {
    if (closed) return;
    closed = true;
    const resolve = waiter;
    waiter = null;
    prompt = null;
    resolve?.(null);
  };

  /** The draft as the terminal should show it: its own lines, with a real carriage return per break. */
  const rendered = (): string => draft.split(LF).join(NEWLINE);

  /**
   * Paints the region: back to the terminal's anchor, clear downwards, print the buffer, place the
   * cursor. Nothing above the anchor is addressed, and the anchor is the terminal's own memory of
   * where the prompt ended — so this is bounded by construction rather than by arithmetic.
   */
  const redraw = (): void => {
    if (prompt === null) return;
    const columns = terminalWidth();
    write(`${RESTORE_CURSOR}${ERASE_DOWN}${rendered()}`);
    const position = cursorPosition(draft, cursor, columns);
    const up = position.rows - 1 - position.row;
    if (up > 0) write(cursorUp(up));
    write(column(position.column + 1));
  };

  /** Inserts text at the cursor — typed or pasted — and repaints. */
  const insert = (text: string): void => {
    if (text.length === 0) return;
    draft = draft.slice(0, cursor) + text + draft.slice(cursor);
    cursor += text.length;
    redraw();
  };

  const submit = (): void => {
    // Every grapheme of the buffer, exactly as composed, and exactly once.
    const answer = draft;
    draft = "";
    cursor = 0;
    // The request stays on screen as output, over as many rows as it has lines: it is written below
    // the anchor and never re-entered, so it is history like anything else the session printed.
    write(`${RESTORE_CURSOR}${ERASE_DOWN}${answer.split(LF).join(NEWLINE)}${NEWLINE}`);
    deliver(answer);
  };

  const clearDraft = (): void => {
    draft = "";
    cursor = 0;
    write(`${RESTORE_CURSOR}${ERASE_DOWN}^C${NEWLINE}`);
    if (prompt !== null) {
      // The prompt is written again on the fresh row, and the anchor moves with it.
      write(prompt);
      write(SAVE_CURSOR);
    }
  };

  /** One grapheme before the cursor, or `""` at the start of the buffer. */
  const beforeCursor = (): string => (cursor === 0 ? "" : lastGrapheme(draft.slice(0, cursor)));

  /** One grapheme at the cursor, or `""` at the end of the buffer. */
  const atCursor = (): string => {
    if (cursor >= draft.length) return "";
    const [first] = graphemes(draft.slice(cursor));
    return first ?? "";
  };

  const backspace = (): void => {
    const removed = beforeCursor();
    // At the beginning this is a no-op — and a no-op that writes nothing, so the terminal is not
    // repainted for a keystroke that changed nothing.
    if (removed.length === 0) return;
    draft = draft.slice(0, cursor - removed.length) + draft.slice(cursor);
    cursor -= removed.length;
    redraw();
  };

  const deleteForward = (): void => {
    const removed = atCursor();
    if (removed.length === 0) return;
    draft = draft.slice(0, cursor) + draft.slice(cursor + removed.length);
    redraw();
  };

  /** Where the cursor is, as line and grapheme column, for vertical movement. */
  const lineAndColumn = (): { readonly line: number; readonly offset: number } => {
    const before = draft.slice(0, cursor);
    const line = before.split(LF).length - 1;
    const offset = graphemes(before.slice(before.lastIndexOf(LF) + 1)).length;
    return { line, offset };
  };

  const placeCursor = (line: number, offset: number): void => {
    const lines = draft.split(LF);
    const target = Math.max(0, Math.min(line, lines.length - 1));
    let start = 0;
    for (let index = 0; index < target; index += 1) start += (lines[index] ?? "").length + 1;
    const parts = graphemes(lines[target] ?? "");
    const take = Math.max(0, Math.min(offset, parts.length));
    const text = parts.slice(0, take).join("");
    cursor = start + text.length;
    redraw();
  };

  const moveLeft = (): void => {
    const removed = beforeCursor();
    if (removed.length === 0) return;
    cursor -= removed.length;
    redraw();
  };

  const moveRight = (): void => {
    const next = atCursor();
    if (next.length === 0) return;
    cursor += next.length;
    redraw();
  };

  const moveUp = (): void => {
    const { line, offset } = lineAndColumn();
    if (line === 0) return;
    placeCursor(line - 1, offset);
  };

  const moveDown = (): void => {
    const { line, offset } = lineAndColumn();
    if (line >= draft.split(LF).length - 1) return;
    placeCursor(line + 1, offset);
  };

  const moveHome = (): void => {
    const { line } = lineAndColumn();
    placeCursor(line, 0);
  };

  const moveEnd = (): void => {
    const { line } = lineAndColumn();
    const lines = draft.split(LF);
    placeCursor(line, graphemes(lines[line] ?? "").length);
  };

  const feed = (chunk: string): void => {
    pending += chunk;
    for (;;) {
      if (pasting) {
        const end = pending.indexOf(PASTE_END);
        if (end >= 0) {
          insert(normalisePaste(pending.slice(0, end)));
          pending = pending.slice(end + PASTE_END.length);
          pasting = false;
          continue;
        }
        // Hold back anything that could still turn into the end marker, so a split marker is not
        // pasted as text.
        const held = partialMarkerPrefix(pending, PASTE_END);
        if (held.length > 0) {
          insert(normalisePaste(pending.slice(0, pending.length - held.length)));
          pending = held;
        } else {
          // A CR at the very end of a chunk may be half of a CRLF, so it is held until the next
          // chunk says which it was.
          const heldCr = pending.endsWith(CR) ? CR : "";
          insert(normalisePaste(heldCr.length > 0 ? pending.slice(0, -1) : pending));
          pending = heldCr;
        }
        return;
      }

      const next = nextToken(pending);
      if (next === null) return;
      pending = pending.slice(next.length);
      switch (next.kind) {
        case "paste-start":
          pasting = true;
          break;
        case "submit":
          // A CRLF pair is one Enter, not two submissions.
          if (next.length === 1 && next.text === CR && pending.startsWith(LF)) pending = pending.slice(1);
          submit();
          break;
        case "backspace":
          backspace();
          break;
        case "delete":
          deleteForward();
          break;
        case "left":
          moveLeft();
          break;
        case "right":
          moveRight();
          break;
        case "up":
          moveUp();
          break;
        case "down":
          moveDown();
          break;
        case "home":
          moveHome();
          break;
        case "end":
          moveEnd();
          break;
        case "interrupt":
          if (draft.length > 0) clearDraft(); else endSession();
          break;
        case "eof":
          if (draft.length === 0) endSession();
          break;
        case "text":
          insert(next.text);
          break;
        case "ignore":
          break;
      }
    }
  };

  type Token =
    | { readonly kind: "text" | "submit" | "backspace" | "delete" | "left" | "right" | "up" | "down" | "home" | "end" | "interrupt" | "eof" | "ignore"; readonly text: string; readonly length: number }
    | { readonly kind: "paste-start"; readonly text: string; readonly length: number };

  /** The movement and editing keys this composer implements, by the sequence a terminal sends. */
  const KEYS: readonly (readonly [readonly string[], Token["kind"]])[] = Object.freeze([
    [["\u001b[A", "\u001b[1A", "\u001bOA"], "up"],
    [["\u001b[B", "\u001b[1B", "\u001bOB"], "down"],
    [["\u001b[C", "\u001b[1C", "\u001bOC"], "right"],
    [["\u001b[D", "\u001b[1D", "\u001bOD"], "left"],
    [["\u001b[H", "\u001b[1~", "\u001b[7~", "\u001bOH"], "home"],
    [["\u001b[F", "\u001b[1K", "\u001b[4~", "\u001b[8~", "\u001bOF"], "end"],
    [["\u001b[3~"], "delete"],
  ]);

  /**
   * The next thing the byte stream says, or `null` when it does not say enough yet.
   *
   * Ordered by what can be longest: the paste marker first, then the keys this composer implements,
   * then a whole escape sequence — an unimplemented key, a mouse report, a bracketed-paste status
   * reply — consumed and dropped rather than half-parsed, then the single bytes. An incomplete
   * escape sequence stops the parse rather than being dropped, because the rest is in the next chunk.
   */
  function nextToken(text: string): Token | null {
    if (text.length === 0) return null;
    if (text.startsWith(PASTE_START)) return { kind: "paste-start", text: PASTE_START, length: PASTE_START.length };
    const held = partialMarkerPrefix(text, PASTE_START);
    if (held.length > 0 && held.length === text.length) return null;
    for (const [sequences, kind] of KEYS) {
      for (const sequence of sequences) {
        if (text.startsWith(sequence)) return { kind, text: sequence, length: sequence.length };
        // A prefix of a movement key: wait for the rest rather than treating ESC as a key of its own.
        if (sequence.startsWith(text) && text.startsWith("\u001b")) return null;
      }
    }
    if (text.startsWith("\u001b")) {
      const end = escapeEnd(text);
      if (end === null) return null;
      return { kind: "ignore", text: text.slice(0, end), length: end };
    }
    const char = text[0]!;
    if (char === CR || char === LF) return { kind: "submit", text: char, length: 1 };
    if (char === BACKSPACE || char === BACKSPACE_ALT) return { kind: "backspace", text: char, length: 1 };
    if (char === INTERRUPT) return { kind: "interrupt", text: char, length: 1 };
    if (char === EOT) return { kind: "eof", text: char, length: 1 };
    // Ctrl+A and Ctrl+E, which every shell user's fingers know.
    if (char === "\u0001") return { kind: "home", text: char, length: 1 };
    if (char === "\u0005") return { kind: "end", text: char, length: 1 };
    if (char < " ") {
      // Any other control byte is not part of a request, and is dropped rather than pasted in.
      return { kind: "ignore", text: char, length: 1 };
    }
    // Plain text, up to whatever comes next: this is the common case and it stays one token.
    const stop = text.slice(1).search(/[\r\n\u007f\b\u0003\u0004\u0001\u0005\x1b]/);
    const end = stop < 0 ? text.length : stop + 1;
    return { kind: "text", text: text.slice(0, end), length: end };
  }

  /** The length of the escape sequence starting at 0, or `null` when it is not complete yet. */
  function escapeEnd(text: string): number | null {
    if (!text.startsWith("\u001b")) return null;
    if (text.length === 1) return null;
    const second = text[1]!;
    if (second === "[") {
      for (let index = 2; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        // Final byte of a CSI sequence: 0x40-0x7E.
        if (code >= 0x40 && code <= 0x7e) return index + 1;
      }
      return null;
    }
    if (second === "O") {
      return text.length >= 3 ? 3 : null;
    }
    return 2;
  }

  const onData = (chunk: Buffer | string): void => {
    if (closed) return;
    feed(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  };

  options.input.on("data", onData);
  options.input.on("end", endSession);
  options.input.on("close", endSession);

  if (terminal) {
    options.input.setRawMode?.(true);
    // Until this is written the terminal never marks a paste, and the markers below never arrive.
    write(BRACKETED_PASTE_ON);
  }

  const ask = async (question: string): Promise<string | null> => {
    if (closed) return null;
    const queued = submitted.shift();
    if (queued !== undefined) return queued;
    prompt = question;
    draft = "";
    cursor = 0;
    write(question);
    // The anchor: wherever the terminal says the cursor is once the prompt has been written. Every
    // redraw returns here, which is what bounds the region to rows this module owns.
    write(SAVE_CURSOR);
    return await new Promise<string | null>((resolve) => { waiter = resolve; });
  };

  /**
   * Resolves once the bytes already delivered have been processed.
   *
   * `setImmediate` and nothing else: the point of this module is that input correctness does not
   * depend on how long anything took, so the thing tests await is a turn of the event loop.
   */
  const idle = async (): Promise<void> => {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  };

  const close = (): void => {
    if (terminal) {
      write(BRACKETED_PASTE_OFF);
      options.input.setRawMode?.(false);
    }
    if (closed) return;
    closed = true;
    const resolve = waiter;
    waiter = null;
    prompt = null;
    resolve?.(null);
  };

  return Object.freeze({ ask, idle, close });
}
