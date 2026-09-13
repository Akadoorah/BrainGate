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
const BACKSPACE = "\u007f";
const BACKSPACE_ALT = "\b";
const INTERRUPT = "\u0003";
const EOT = "\u0004";

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
  /** Lines of the current draft that the terminal is already showing, for the paste marker. */
  let renderedLines = 0;
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
    renderedLines = 0;
    write(LF);
    deliver(answer);
  };

  const clearDraft = (): void => {
    draft = "";
    renderedLines = 0;
    write("^C\n");
    if (prompt !== null) write(prompt);
  };

  /** Appends pasted or typed text, echoing it as the lines it contains. */
  const append = (text: string, pasted: boolean): void => {
    if (text.length === 0) return;
    draft += text;
    write(text);
    const lines = text.split(LF).length - 1;
    renderedLines += lines;
    if (pasted && lines > 0) {
      // Said once, at the end of a paste: what is pending, and what will send it. The next prompt is
      // reprinted so typing continues on the last line, the way a multiline composer behaves.
      write(`${LF}${continuation}[${String(lines + 1)} lines pending — Enter sends, Ctrl+C clears]${LF}${prompt ?? ""}`);
      renderedLines += 1;
    }
  };

  const backspace = (): void => {
    if (draft.length === 0) return;
    const removed = draft.slice(-1);
    draft = draft.slice(0, -1);
    // Only the current line is edited in place. Deleting back across a paste boundary is not
    // supported, and pretending otherwise would leave the display disagreeing with the draft.
    if (removed === LF) { renderedLines -= 1; return; }
    write(`${BACKSPACE} ${BACKSPACE}`);
  };

  const feed = (chunk: string): void => {
    pending += chunk;
    for (;;) {
      if (pasting) {
        const end = pending.indexOf(PASTE_END);
        if (end >= 0) {
          append(pending.slice(0, end), true);
          pending = pending.slice(end + PASTE_END.length);
          pasting = false;
          continue;
        }
        // Hold back anything that could still turn into the end marker, so a split marker is not
        // pasted as text.
        const held = partialMarkerPrefix(pending, PASTE_END);
        if (held.length > 0) {
          append(pending.slice(0, pending.length - held.length), true);
          pending = held;
        } else {
          append(pending, true);
          pending = "";
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
          append(next.text, false);
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
    // Any other escape sequence — arrows, Home, End, a function key — is consumed whole and ignored.
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
    renderedLines = 0;
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
