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
 * ## The logical draft and the visible line are two different things
 *
 * Real dogfood typed `مرحبا` into macOS Terminal and pressed Backspace, and the screen kept showing
 * letters that had been deleted. Two independent assumptions had been made, and Arabic broke both:
 *
 * 1. **One JavaScript character is one character.** `draft.slice(0, -1)` removes a UTF-16 code unit.
 *    For `ا` that is the whole letter; for an emoji, a combining mark, or a flagged sequence it is
 *    half a character — a lone surrogate or an orphaned diacritic left in the buffer, still submitted.
 *    Deletion is now one *grapheme cluster*, via `Intl.Segmenter` where it exists.
 * 2. **One grapheme is one terminal cell that can be erased in place.** `\u007f \u007f` moves the
 *    cursor back one column, overwrites it with a space, and moves back again. That is only true for
 *    single-width, left-to-right text that the terminal lays out in logical order. Arabic is shaped
 *    and reordered by the terminal, so the cell to the left of the cursor is generally *not* the
 *    character that was deleted — the erase lands somewhere else and the old glyph stays on screen.
 *
 * So the module keeps an **anchor**, not a running cursor: the row the first line of the draft sits
 * on, counted from where the cursor ends up after a render. Every edit mutates the logical buffer
 * first, then clears from that anchor to the end of the display and prints the whole draft again. The
 * terminal is left to shape and order whatever it is handed, which is the one thing it can do
 * correctly for text this module cannot measure. What is on screen after a redraw is the draft, in
 * full, every time — nothing incremental is assumed about how many cells a character occupies or which
 * direction it was laid out in.
 *
 * Cursor keys are deliberately not honoured. Left and Right cannot be implemented safely above a
 * terminal that owns BiDi reordering: logical position and visual column stop being the same thing,
 * and moving one cell is a guess about shaping, width and direction. Guessing is what produced this
 * bug. Until a real line editor exists here — one that measures width and tracks the terminal's own
 * direction — the composer supports **append at the end, grapheme-aware Backspace at the end, and a
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

/** Cursor up `rows`, from the anchor to the first line of the draft. Never emitted with 0. */
const cursorUp = (rows: number): string => `\u001b[${String(rows)}A`;
/** Cursor down one row, column unchanged. Used to step off the last line of a multi-line draft. */
const CURSOR_DOWN = "\u001b[1B";
/** Erase from the cursor to the end of the display, cursor unmoved. */
const ERASE_DOWN = "\u001b[J";

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

export function createPromptInput(options: PromptInputOptions): PromptInput {
  const terminal = options.terminal ?? options.input.isTTY === true;
  const continuation = options.continuation ?? "  ";

  /** The draft being composed: everything the operator has entered and not yet submitted. */
  let draft = "";
  /** The question of the ask currently waiting, or `null` between asks. */
  let prompt: string | null = null;
  let waiter: ((answer: string | null) => void) | null = null;
  /** Bytes not yet parsed: an incomplete escape sequence, or a paste that has not ended. */
  let pending = "";
  /** Inside a bracketed paste. Newlines in here are content, and the end marker is not a submit. */
  let pasting = false;
  /**
   * Whether the last thing written left the cursor on an empty line.
   *
   * Not an assumption about the terminal — a count of the line breaks this module itself wrote. It is
   * what lets the paste notice go on the row after the draft without stepping over the last line when
   * the draft already ends with a line break of its own.
   */
  let cursorOnFreshLine = false;
  /**
   * The anchor: how many rows above the cursor the first line of the draft sits.
   *
   * Recomputed by every render rather than adjusted by each edit, because that is the whole point.
   * The draft is reprinted from a known place instead of being edited cell by cell in a place this
   * module cannot measure.
   */
  let rowsAboveDraftStart = 0;
  /** The line count the last render reported as pending, or 0 when there is no notice showing. */
  let pasteNoticeLines = 0;
  let closed = false;

  const write = options.write;

  /** One submitted answer, delivered to whoever is asking or queued for the ask that comes next. */
  const submitted: string[] = [];

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

  const submit = (): void => {
    // Every line of the draft, exactly as it was composed. A trailing newline the operator typed is
    // part of what they wrote, and removing it here would be this module editing a request.
    const answer = draft;
    draft = "";
    forgetRender();
    write(NEWLINE);
    deliver(answer);
  };

  const clearDraft = (): void => {
    draft = "";
    forgetRender();
    write(`^C${NEWLINE}`);
    if (prompt !== null) write(prompt);
  };

  /** No draft is on screen any more, so there is nothing to move back to or clear. */
  const forgetRender = (): void => {
    rowsAboveDraftStart = 0;
    pasteNoticeLines = 0;
    cursorOnFreshLine = true;
  };

  /**
   * Prints the draft as the terminal should currently be showing it, returning the cursor to the end.
   *
   * The order matters and is the fix: move to the anchor the previous render left the draft at, erase
   * everything from there down, and print the draft again in full. Nothing here decides how wide a
   * character is, which cell it occupies, or which way the terminal will lay it out — a line is
   * cleared as *a line*, not as a run of cells counted from the cursor. An emoji, an Arabic letter
   * with two diacritics, and a Latin word are all just text to be reprinted, and whatever the
   * terminal does with them, the screen ends up showing the draft the buffer actually holds.
   *
   * Reached after every edit, which is why Backspace can be correct without knowing anything about
   * the text it just deleted.
   */
  const redraw = (): void => {
    if (prompt === null) return;
    const lines = draft.split(LF).length - 1;
    if (rowsAboveDraftStart > 0) write(cursorUp(rowsAboveDraftStart));
    write(`${CR}${ERASE_DOWN}${prompt}${draft}`);
    pasteNoticeLines = 0;
    if (lines > 0) {
      // The line count is said once per pending draft, under it, the way a multiline composer
      // behaves. It is drawn inside the region that was just cleared, so it can never be a stale
      // suffix: the next redraw erases it along with everything else below the anchor.
      pasteNoticeLines = lines + 1;
      if (!cursorOnFreshLine) write(CURSOR_DOWN);
      write(`${CR}${continuation}[pasted ${String(lines + 1)} lines — Enter sends, Ctrl+C clears]`);
    }
    // Where the cursor now is, measured from the first line of the draft: one row per line, plus the
    // notice's own row when one is showing. The cursor ends the render where the text ends, so the
    // same anchor is still the draft's first line next time.
    rowsAboveDraftStart = lines + pasteNoticeLines;
    cursorOnFreshLine = false;
  };

  /** Appends typed or pasted text to the logical buffer, then prints the buffer again. */
  const append = (text: string): void => {
    if (text.length === 0) return;
    draft += text;
    cursorOnFreshLine = text.endsWith(LF);
    redraw();
  };

  /**
   * Paste content, with its line endings normalised and nothing else touched.
   *
   * A terminal is free to send CR for a pasted newline — macOS Terminal does — and a CR left in the
   * stored request is not a cosmetic problem: every renderer that follows honours it, so the cursor
   * returns to column 0 and the next line is written *over* the previous one. Real dogfood stored a
   * goal objective containing `\r\r` where its blank lines were, and `/goal` displayed a spliced
   * sentence ("…reversible DIRECT-mod" + "3. one harmless…") that never existed in what was pasted.
   *
   * So the normalisation happens here, once, on the way in: CRLF and lone CR become LF. Everything
   * else — blank lines, numbered lists, punctuation, a trailing newline — is kept exactly, because
   * the draft that is submitted has to be the text that was pasted.
   */
  const normalisePaste = (text: string): string => text.replace(/\r\n?/g, LF);

  /**
   * Backspace: one user-perceived character off the end of the logical buffer, then a fresh render.
   *
   * The buffer is edited first and the display is made to agree afterwards, in that order, because
   * the reverse is what broke: an incremental erase describes a *screen state* the module cannot
   * verify for shaped text, while the draft is plain data it can always get right.
   */
  const backspace = (): void => {
    if (draft.length === 0) return;
    const removed = lastGrapheme(draft);
    if (removed.length === 0) return;
    draft = draft.slice(0, draft.length - removed.length);
    cursorOnFreshLine = draft.endsWith(LF);
    redraw();
  };

  const feed = (chunk: string): void => {
    pending += chunk;
    for (;;) {
      if (pasting) {
        const end = pending.indexOf(PASTE_END);
        if (end >= 0) {
          append(normalisePaste(pending.slice(0, end)));
          pending = pending.slice(end + PASTE_END.length);
          pasting = false;
          continue;
        }
        // Hold back anything that could still turn into the end marker, so a split marker is not
        // pasted as text.
        const held = partialMarkerPrefix(pending, PASTE_END);
        if (held.length > 0) {
          append(normalisePaste(pending.slice(0, pending.length - held.length)));
          pending = held;
        } else {
          // A CR at the very end of a chunk may be half of a CRLF, so it is held until the next
          // chunk says which it was.
          const heldCr = pending.endsWith(CR) ? CR : "";
          append(normalisePaste(heldCr.length > 0 ? pending.slice(0, -1) : pending));
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
        case "interrupt":
          if (draft.length > 0) clearDraft(); else endSession();
          break;
        case "eof":
          if (draft.length === 0) endSession();
          break;
        case "text":
          append(next.text);
          break;
        case "ignore":
          break;
      }
    }
  };

  type Token =
    | { readonly kind: "text" | "submit" | "backspace" | "interrupt" | "eof" | "ignore"; readonly text: string; readonly length: number }
    | { readonly kind: "paste-start"; readonly text: string; readonly length: number };

  /**
   * The next thing the byte stream says, or `null` when it does not say enough yet.
   *
   * Ordered by what can be longest: the paste marker first, then a whole escape sequence, then the
   * single bytes. An incomplete escape sequence stops the parse rather than being dropped, because
   * the rest of it is in the next chunk.
   */
  function nextToken(text: string): Token | null {
    if (text.length === 0) return null;
    if (text.startsWith(PASTE_START)) return { kind: "paste-start", text: PASTE_START, length: PASTE_START.length };
    const held = partialMarkerPrefix(text, PASTE_START);
    if (held.length > 0 && held.length === text.length) return null;
    // Every other escape sequence — Left, Right, Home, End, a function key, a mouse report — is
    // consumed whole and ignored. This is the deliberate limitation described at the top of the file:
    // a cursor key means "move to that place in the text", and for shaped or bidirectional text this
    // module cannot know where "that place" is, because the terminal reorders what it is given. A
    // Left arrow that guessed one code point or one cell would put the next Backspace in a position
    // the operator did not choose and would corrupt the draft while looking like it worked. So the
    // key is dropped rather than half-implemented: the draft is edited at the end, and the escape
    // sequence never reaches the buffer.
    if (text.startsWith("\x1b")) {
      const end = escapeEnd(text);
      if (end === null) return null;
      return { kind: "ignore", text: text.slice(0, end), length: end };
    }
    const char = text[0]!;
    if (char === CR || char === LF) return { kind: "submit", text: char, length: 1 };
    if (char === BACKSPACE || char === BACKSPACE_ALT) return { kind: "backspace", text: char, length: 1 };
    if (char === INTERRUPT) return { kind: "interrupt", text: char, length: 1 };
    if (char === EOT) return { kind: "eof", text: char, length: 1 };
    if (char < " ") {
      // Any other control byte is not part of a request, and is dropped rather than pasted in.
      return { kind: "ignore", text: char, length: 1 };
    }
    // Plain text, up to whatever comes next: this is the common case and it stays one token.
    const stop = text.slice(1).search(/[\r\n\u007f\b\u0003\u0004\x1b]/);
    const length = stop < 0 ? text.length : stop + 1;
    return { kind: "text", text: text.slice(0, length), length };
  }

  /** Where an escape sequence ends, or `null` when this chunk does not contain all of it. */
  function escapeEnd(text: string): number | null {
    if (text.length < 2) return null;
    const second = text[1]!;
    if (second === "[") {
      // CSI: parameter and intermediate bytes, then one final byte in @–~.
      for (let index = 2; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
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
    forgetRender();
    // A question that ends its own line leaves the cursor on an empty row, and one that does not
    // leaves it mid-row. Every prompt this CLI writes today is the second kind; the fact is taken from
    // the string rather than assumed, so the geometry stays right if that ever changes.
    cursorOnFreshLine = question.endsWith(LF);
    write(question);
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
