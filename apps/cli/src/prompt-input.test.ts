import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createPromptInput, type PromptInputOptions, displayWidth, fallbackLastGrapheme, lastGrapheme, PASTE_END, PASTE_START, type PromptInput } from "./prompt-input.js";
import { classifyRequestIntent } from "./request-intent.js";

/**
 * Prompt input correctness: paste is a boundary, not a race.
 *
 * Every test here drives raw bytes through the composer and asserts what was submitted. None of them
 * sleeps, waits on a timer, or depends on how fast the machine is — the defect these exist for was a
 * 25 ms window that "usually" collected a paste, and a test that needs a clock to pass cannot tell
 * that from a test that needs a clock to fail.
 *
 * The bytes are the bytes: a terminal in bracketed-paste mode sends `ESC[200~`, the pasted content
 * exactly as it was copied, and `ESC[201~`. Enter is CR. That is the whole protocol this relies on,
 * and it is what makes "inside a paste" a fact rather than an inference.
 */

/** A terminal: chunks in, writes recorded, submissions observable. */
class Terminal {
  readonly #data: ((chunk: string) => void)[] = [];
  readonly #end: (() => void)[] = [];
  readonly #written: string[] = [];
  rawModes: boolean[] = [];
  readonly input: PromptInput;

  constructor(options: { readonly terminal?: boolean; readonly onWrite?: (text: string) => void; readonly columns?: number; readonly rows?: number; readonly suggest?: PromptInputOptions["suggest"] } = {}) {
    this.input = createPromptInput({
      ...(options.suggest === undefined ? {} : { suggest: options.suggest }),
      ...(options.rows === undefined ? {} : { rows: options.rows }),
      input: {
        on: (event: string, listener: never) => {
          if (event === "data") this.#data.push(listener);
          else this.#end.push(listener);
          return this;
        },
        setRawMode: (mode: boolean) => { this.rawModes.push(mode); },
        isTTY: options.terminal ?? true,
      },
      write: (text: string) => { this.#written.push(text); options.onWrite?.(text); },
      terminal: options.terminal ?? true,
      // A width wide enough that the draft fits, unless a test is about the fitting.
      columns: options.columns ?? 200,
    });
  }

  chunk(text: string): void { for (const listener of [...this.#data]) listener(text); }
  type(text: string): void { for (const character of text) this.chunk(character); }
  enter(): void { this.chunk("\r"); }
  end(): void { for (const listener of [...this.#end]) listener(); }
  written(): string { return this.#written.join(""); }

  /** A paste, framed the way a terminal frames one. Optionally split mid-marker. */
  paste(content: string, options: { readonly splitAt?: number } = {}): void {
    const framed = `${PASTE_START}${content}${PASTE_END}`;
    if (options.splitAt === undefined) { this.chunk(framed); return; }
    this.chunk(framed.slice(0, options.splitAt));
    this.chunk(framed.slice(options.splitAt));
  }

  close(): void { this.input.close(); }
}

/** A submission log, so "was anything submitted" is a list rather than a promise that may hang. */
function submissions(terminal: Terminal): { readonly ask: (question: string) => Promise<string | null>; readonly all: string[] } {
  const all: string[] = [];
  const ask = async (question: string): Promise<string | null> => {
    const answer = await terminal.input.ask(question);
    if (answer !== null) all.push(answer);
    return answer;
  };
  return { ask, all };
}

/**
 * A terminal that *displays* what it is written, so the screen can be asserted instead of the bytes.
 *
 * This is the fixture the RTL defect needed. The bug was not only in the buffer: the composer erased
 * one cell with `\u007f \u007f`, which is a claim about where a character is on screen, and for
 * shaped Arabic that claim is false — the erase landed beside the character and the old glyph stayed
 * visible. No assertion about the composer's own memory can catch that, because the memory was fine.
 *
 * So the emitted bytes are interpreted the way a terminal interprets them: cursor up, cursor down,
 * erase to end of display, carriage return, newline. What a row holds afterwards is what an operator
 * would see on that row. Escape sequences that are not display movement (bracketed paste in and out)
 * are dropped, and any other byte changes a row.
 *
 * Rows are never re-flowed for width, so a soft-wrapped long line is out of scope — the geometry here
 * is the composer's own claim (one newline is one row), which is exactly the claim under test.
 */
class VirtualTerminal {
  readonly #rows: string[] = [""];
  #row = 0;
  #column = 0;
  /** How many cells a row holds before the terminal wraps, or 0 for a terminal that never wraps. */
  readonly #columns: number;
  /** How many rows the screen shows before it scrolls, or 0 for a screen that never scrolls. */
  readonly #height: number;
  /** Rows that scrolled off the top: the scrollback a person would see above the screen. */
  readonly #scrollback: string[] = [];
  /** Where each erase-to-end-of-display started, which is the invariant under test. */
  readonly #eraseStarts: { readonly row: number; readonly column: number }[] = [];

  constructor(columns = 0, height = 0) { this.#columns = columns; this.#height = height; }

  /**
   * The cursor moved down a row: when the screen is full, everything scrolls up by one, and — as
   * on a real terminal — the saved cursor keeps its absolute row, which now points one row too high.
   */
  #advanceRow(): void {
    this.#row += 1;
    while (this.#height > 0 && this.#row >= this.#height) {
      this.#scrollback.push(this.#rows.shift() ?? "");
      this.#row -= 1;
      if (this.#saved !== null) this.#saved.row = Math.max(0, this.#saved.row - 1);
    }
    while (this.#rows.length <= this.#row) this.#rows.push("");
  }

  /** What scrolled off the top, joined by newlines. */
  scrollback(): string { return this.#scrollback.join("\n"); }

  /** The rows each erase began on: the composer may only ever start one inside its own region. */
  eraseStarts(): readonly { readonly row: number; readonly column: number }[] { return this.#eraseStarts; }
  /** Where DECSC last put the cursor, or null before the first save. */
  #saved: { row: number; column: number } | null = null;
  /** Every byte written, so a test can also assert what was *not* emitted. */
  #bytes = "";

  write(text: string): void {
    this.#bytes += text;
    for (let index = 0; index < text.length;) {
      const rest = text.slice(index);
      const up = /^\u001b\[(\d*)A/.exec(rest);
      if (up !== null) {
        this.#row = Math.max(0, this.#row - Number(up[1] === "" ? "1" : up[1]));
        this.#column = 0;
        index += up[0].length;
        continue;
      }
      const down = /^\u001b\[(\d*)B/.exec(rest);
      if (down !== null) {
        for (let n = Number(down[1] === "" ? "1" : down[1]); n > 0; n -= 1) this.#advanceRow();
        index += down[0].length;
        continue;
      }
      if (rest.startsWith("\u001b7")) {
        // DECSC: the anchor. The composer erases downwards from wherever this said the prompt ended.
        this.#saved = { row: this.#row, column: this.#column };
        index += 2;
        continue;
      }
      if (rest.startsWith("\u001b8")) {
        // DECRC: back to the anchor, which is the whole safety property under test.
        if (this.#saved !== null) { this.#row = this.#saved.row; this.#column = this.#saved.column; }
        index += 2;
        continue;
      }
      const goto = /^\u001b\[(\d+)G/.exec(rest);
      if (goto !== null) {
        this.#column = Math.max(0, Number(goto[1]) - 1);
        index += goto[0].length;
        continue;
      }
      if (rest.startsWith("\u001b[2K")) {
        // Erase the whole row the cursor is on, cursor unmoved. This is the only erase the composer
        // emits now: it owns one row, and clearing that row cannot reach any other.
        this.#rows[this.#row] = "";
        index += 4;
        continue;
      }
      if (rest.startsWith("\u001b[J")) {
        // Erase from the cursor to the end of the display: this row keeps what is left of it, every
        // row below it is gone. This is the whole mechanism the redraw relies on, and where it starts
        // is what decides whether the operator's history survives — so it is recorded.
        this.#eraseStarts.push({ row: this.#row, column: this.#column });
        this.#rows[this.#row] = (this.#rows[this.#row] ?? "").slice(0, this.#column);
        this.#rows.length = this.#row + 1;
        index += 3;
        continue;
      }
      const char = text[index]!;
      if (char === "\u001b") {
        const escape = /^\u001b\[[0-9;?]*[A-Za-z]/.exec(rest);
        assert.ok(escape !== null, `the composer emitted an escape sequence the fixture cannot read: ${JSON.stringify(rest.slice(0, 12))}`);
        index += escape[0].length;
        continue;
      }
      if (char === "\r") { this.#column = 0; index += 1; continue; }
      if (char === "\n") { this.#advanceRow(); this.#column = 0; index += 1; continue; }
      const point = String.fromCodePoint(text.codePointAt(index)!);
      // A real terminal wraps when the next cell would leave the row. Wrapping is modelled here
      // because the composer's cursor arithmetic depends on it: if this fixture did not wrap, it
      // would agree with a composer that counted rows wrongly.
      if (this.#columns > 0 && this.#column >= this.#columns) { this.#advanceRow(); this.#column = 0; }
      const row = this.#rows[this.#row] ?? "";
      this.#rows[this.#row] = row.slice(0, this.#column) + point + row.slice(this.#column + point.length);
      this.#column += point.length;
      index += point.length;
    }
  }

  /** What is on screen: the rows actually occupied, trailing blanks dropped, joined by newlines. */
  screen(): string {
    return this.#rows.join("\n").replace(/\n+$/, "");
  }

  bytes(): string { return this.#bytes; }

  /** The row the cursor is on, as text — for asserting where the operator is typing. */
  cursorRow(): string { return this.#rows[this.#row] ?? ""; }
  /** The cell the cursor is in on that row, 0-based — for asserting it sits where the typing is. */
  cursorColumn(): number { return this.#column; }
  /** The rows below the cursor's row, for asserting what the composer drew under the draft. */
  rowsBelowCursor(): readonly string[] { return this.#rows.slice(this.#row + 1); }
}

/** A terminal that both records bytes and displays them. */
function displayTerminal(options: { readonly columns?: number; readonly height?: number; readonly suggest?: PromptInputOptions["suggest"] } = {}): { readonly terminal: Terminal; readonly screen: VirtualTerminal } {
  const screen = new VirtualTerminal(options.columns ?? 0, options.height ?? 0);
  const terminal = new Terminal({ onWrite: (text) => { screen.write(text); }, ...(options.columns === undefined ? {} : { columns: options.columns }), ...(options.height === undefined ? {} : { rows: options.height }), ...(options.suggest === undefined ? {} : { suggest: options.suggest }) });
  return { terminal, screen };
}

// ---------------------------------------------------------------- the region at the bottom of the screen

const MENU = [
  { label: "/use <provider>/<model>", hint: "send the next work to this worker", insert: "/use " },
  { label: "/auto", hint: "let BrainGate choose again", insert: "/auto" },
  { label: "/worker", hint: "who is selected", insert: "/worker" },
  { label: "/goal", hint: "the current goal", insert: "/goal" },
  { label: "/new", hint: "set the current goal aside", insert: "/new" },
  { label: "/remember <text>", hint: "record something", insert: "/remember " },
  { label: "/memory", hint: "what is remembered", insert: "/memory" },
  { label: "/status", hint: "recent tasks", insert: "/status" },
];
const suggestFrom = (draft: string) => (draft.startsWith("/") && !draft.includes(" ") && !draft.includes("\n")
  ? MENU.filter((item) => item.label.slice(1).startsWith(draft.slice(1)))
  : []);

test("a menu that scrolls the screen is erased on the next keystroke, not duplicated", async () => {
  // Reported from a real terminal: with the prompt on the last row, typing `/` scrolled the screen to
  // make room for the list, the saved anchor then pointed above the prompt, and every further
  // keystroke painted another copy of the list under the previous one.
  const { terminal, screen } = displayTerminal({ columns: 80, height: 6, suggest: suggestFrom });
  screen.write("history 1\r\nhistory 2\r\nhistory 3\r\nhistory 4\r\nhistory 5\r\n");
  const pending = terminal.input.ask("> ");
  terminal.type("/");
  await terminal.input.idle();
  assert.equal(screen.cursorRow(), "> /");
  assert.equal(screen.cursorColumn(), 3);
  assert.equal((screen.screen().match(/\/use/g) ?? []).length, 1, "one copy of the list");
  // Six rows on screen: the prompt's row and at most five below it, so the list is cut to fit
  // rather than pushing the prompt off the top.
  assert.equal(screen.rowsBelowCursor().filter((row) => row.trim().length > 0).length, 4, "the list is cut to the rows the screen has under the prompt");
  assert.doesNotMatch(screen.screen(), /\/memory/, "the eighth command did not fit and is not shown");

  terminal.type("m");
  await terminal.input.idle();
  assert.equal(screen.cursorRow(), "> /m", "the draft row is still the cursor's row after the scroll");
  assert.equal(screen.cursorColumn(), 4);
  assert.equal((screen.screen().match(/\/memory/g) ?? []).length, 1, "the list was erased and painted once, not added under the old one");
  assert.doesNotMatch(screen.screen(), /\/use|\/auto|\/goal/, "and it is the narrowed list");
  assert.doesNotMatch(screen.scrollback(), /\/use|\/memory/, "no copy of the list was pushed into the scrollback");
  assert.match(screen.scrollback(), /history 1/, "what scrolled off is the operator's own history, in order");

  terminal.chunk("\u007f".repeat(2));
  terminal.type("hello");
  await terminal.input.idle();
  assert.equal(screen.cursorRow(), "> hello");
  assert.doesNotMatch(screen.screen(), /\/memory|what is remembered/, "no residue of the menu once the draft is no longer a command");
  terminal.enter();
  assert.equal(await pending, "hello");
  assert.doesNotMatch(screen.screen(), /\/memory|what is remembered/, "and none after the request is sent");
  assert.match(screen.screen(), /> hello/, "the request stays on screen as history");
});

test("a long draft at the bottom of the screen wraps, scrolls, and shrinks back without residue", async () => {
  const { terminal, screen } = displayTerminal({ columns: 40, height: 4 });
  screen.write("earlier output\r\nmore output\r\nlast line before the prompt\r\n");
  const pending = terminal.input.ask("> ");
  const long = "w".repeat(100);
  terminal.type(long);
  await terminal.input.idle();
  assert.equal(screen.cursorRow(), "w".repeat((2 + 100) % 40), "the cursor is on the last wrapped row");
  assert.equal(screen.cursorColumn(), (2 + 100) % 40);
  terminal.chunk("\u007f".repeat(100));
  await terminal.input.idle();
  assert.equal(screen.cursorRow(), "> ", "deleting the whole draft leaves the prompt alone");
  assert.equal(screen.cursorColumn(), 2);
  assert.equal(screen.screen().split("\n").filter((row) => row.includes("wwww")).length, 0, "no wrapped row of the old draft survives");
  terminal.type("ok");
  terminal.enter();
  assert.equal(await pending, "ok");
});

// ---------------------------------------------------------------- cursor placement and the slash menu

test("the cursor is drawn after the prompt and the draft, not on top of the draft's tail", async () => {
  // Seen on macOS Terminal: "> how ca" with the cursor on the "c". The composer placed the cursor at
  // the draft's own width, forgetting the two cells the prompt occupies on the same row.
  const { terminal, screen } = displayTerminal({ columns: 60 });
  const pending = terminal.input.ask("> ");
  terminal.type("how ca");
  await terminal.input.idle();
  assert.equal(screen.cursorRow(), "> how ca");
  assert.equal(screen.cursorColumn(), "> how ca".length, "the cursor sits after the last typed character");

  // Switching language in the same draft and back: Arabic in, deleted, English typed again.
  terminal.type("سبسبسب");
  terminal.chunk("\u007f".repeat(6));
  await terminal.input.idle();
  assert.equal(screen.cursorRow(), "> how ca");
  assert.equal(screen.cursorColumn(), "> how ca".length, "and is back where it was once the Arabic is deleted");
  terminal.chunk("\u001b[D");
  await terminal.input.idle();
  assert.equal(screen.cursorColumn(), "> how ca".length - 1, "Left moves it one cell, still counting the prompt");

  // A draft that wraps: the prompt's cells count towards the first row.
  const long = "x".repeat(70);
  terminal.chunk("\u001b[F");
  terminal.type(long);
  await terminal.input.idle();
  assert.equal(screen.cursorRow().length, (2 + 6 + 70) - 60, "the cursor is on the wrapped row, after the overflow that includes the prompt's width");
  terminal.enter();
  assert.equal(await pending, `how ca${long}`);
});

test("typing / lists the commands under the draft, narrows as more is typed, and Tab completes", async () => {
  const table = [
    { label: "/goal", hint: "the current goal", insert: "/goal" },
    { label: "/use <provider>/<model>", hint: "send the next work to this worker", insert: "/use " },
    { label: "/worker", hint: "who is selected", insert: "/worker" },
  ];
  const suggest = (draft: string) => (draft.startsWith("/") && !draft.includes(" ") && !draft.includes("\n")
    ? table.filter((item) => item.label.slice(1).startsWith(draft.slice(1)))
    : []);
  const { terminal, screen } = displayTerminal({ columns: 80, suggest });
  const pending = terminal.input.ask("> ");
  terminal.type("/");
  await terminal.input.idle();
  assert.equal(screen.cursorRow(), "> /", "the draft row is the cursor's row");
  assert.equal(screen.cursorColumn(), 3);
  const below = screen.rowsBelowCursor().join("\n");
  assert.match(below, /\/goal\s+the current goal/, "the menu names every command");
  assert.match(below, /\/use <provider>\/<model>\s+send the next work/);
  assert.match(below, /\/worker/);

  terminal.type("wo");
  await terminal.input.idle();
  const narrowed = screen.rowsBelowCursor().join("\n");
  assert.match(narrowed, /\/worker/, "only the matching command is left");
  assert.doesNotMatch(narrowed, /\/goal|\/use/);

  terminal.chunk("\t");
  await terminal.input.idle();
  assert.equal(screen.cursorRow(), "> /worker", "Tab completes the draft");
  assert.equal(screen.cursorColumn(), "> /worker".length);

  // A command with arguments completes to the command and a space, ready for them; the menu is gone.
  terminal.chunk("\u007f".repeat(7));
  terminal.type("/u");
  terminal.chunk("\t");
  await terminal.input.idle();
  assert.equal(screen.cursorRow(), "> /use ");
  assert.equal(screen.rowsBelowCursor().join("").trim(), "", "once the arguments start, nothing is offered");

  terminal.chunk("\u007f".repeat(6));
  terminal.type("/goal");
  terminal.enter();
  assert.equal(await pending, "/goal");
  assert.equal(screen.rowsBelowCursor().join("").trim(), "", "the menu leaves nothing behind once the request is sent");
});

test("a paste or a multi-line draft never opens the menu, and a draft without a slash offers nothing", async () => {
  const calls: string[] = [];
  const suggest = (draft: string) => { calls.push(draft); return draft.startsWith("/") && !draft.includes("\n") ? [{ label: "/goal", hint: "g", insert: "/goal" }] : []; };
  const { terminal, screen } = displayTerminal({ columns: 80, suggest });
  const pending = terminal.input.ask("> ");
  terminal.paste("/goal\nsecond line");
  await terminal.input.idle();
  assert.equal(screen.rowsBelowCursor().join("").trim(), "", "a multi-line draft is a request, not a command being typed");
  terminal.chunk("\u0003");
  terminal.type("hello");
  await terminal.input.idle();
  assert.equal(screen.rowsBelowCursor().join("").trim(), "");
  terminal.enter();
  assert.equal(await pending, "hello");
});

// ---------------------------------------------------------------- A. typed input

test("A: a typed single line submits once, on Enter", async () => {
  const terminal = new Terminal();
  const { ask, all } = submissions(terminal);
  const pending = ask("> ");
  terminal.type("inspect auth.dart");
  await terminal.input.idle();
  assert.deepEqual(all, [], "nothing is submitted before Enter");
  terminal.enter();
  assert.equal(await pending, "inspect auth.dart");
  assert.deepEqual(all, ["inspect auth.dart"], "exactly one submission");
  assert.equal(terminal.written().includes("inspect auth.dart"), true, "and it was echoed");
});

test("A: Backspace edits the draft before it is sent", async () => {
  const terminal = new Terminal();
  const pending = terminal.input.ask("> ");
  terminal.type("inspect auth.dar");
  terminal.chunk("\u007f");   // removes the r
  terminal.type("rt");
  terminal.enter();
  assert.equal(await pending, "inspect auth.dart");
});

// ---------------------------------------------------------------- B. paste without a trailing newline

test("B: a paste with no trailing newline does not submit, and the next Enter sends it whole", async () => {
  const terminal = new Terminal();
  const { ask, all } = submissions(terminal);
  const pending = ask("> ");
  terminal.paste("Which file is safe?\nExplain why.");
  await terminal.input.idle();
  assert.deepEqual(all, [], "the end of a paste is not a submit");
  // The draft is painted as its own lines, so there is nothing to announce: what is pending *is* what
  // is on screen.
  assert.match(terminal.written(), /Which file is safe\?\r\nExplain why\./, "the whole draft is painted, on its own lines");

  terminal.enter();
  assert.equal(await pending, "Which file is safe?\nExplain why.");
  assert.deepEqual(all, ["Which file is safe?\nExplain why."]);
});

// ---------------------------------------------------------------- C. paste with a trailing newline

test("C: a paste that ends with a newline still does not submit", async () => {
  const terminal = new Terminal();
  const { ask, all } = submissions(terminal);
  const pending = ask("> ");
  // This is the case that produced the dogfood bug: the paste's own final newline was read as the
  // operator pressing Enter.
  terminal.paste("Inspect this repository.\n\nDo not modify anything yet.\n");
  await terminal.input.idle();
  assert.deepEqual(all, [], "a trailing newline inside a paste is content, not a submit");

  terminal.enter();
  assert.equal(await pending, "Inspect this repository.\n\nDo not modify anything yet.\n", "the text is kept exactly");
  assert.deepEqual(all, ["Inspect this repository.\n\nDo not modify anything yet.\n"], "and submitted once");
});

// ---------------------------------------------------------------- D. blank lines

test("D: blank lines inside a paste are preserved exactly", async () => {
  const terminal = new Terminal();
  const pending = terminal.input.ask("> ");
  const content = "First.\n\n\nSecond.\n\nThird.";
  terminal.paste(content);
  terminal.enter();
  assert.equal(await pending, content);
});

// ---------------------------------------------------------------- E. no duplicate line

test("E: paste then Enter produces exactly one request, with no duplicated line", async () => {
  const terminal = new Terminal();
  const { ask, all } = submissions(terminal);
  const pending = ask("> ");
  terminal.paste("one\ntwo\nthree\n");
  await terminal.input.idle();
  terminal.enter();
  const answer = await pending;
  assert.equal(answer, "one\ntwo\nthree\n");
  assert.equal(answer?.split("\n").filter((line) => line === "one").length, 1, "the first line appears once");
  assert.deepEqual(all, ["one\ntwo\nthree\n"], "one submission, not one per line");
});

// ---------------------------------------------------------------- F. confirmation consumption

test("F: y after a pasted request is consumed by the confirmation, not by the request", async () => {
  const terminal = new Terminal();
  const request = terminal.input.ask("> ");
  terminal.paste("Review this file.\nDo not modify it.\n");
  await terminal.input.idle();
  terminal.enter();
  assert.equal(await request, "Review this file.\nDo not modify it.\n");

  const confirmation = terminal.input.ask("  Run it? [y/N] ");
  await terminal.input.idle();
  terminal.type("y");
  await terminal.input.idle();
  assert.notEqual(await Promise.race([confirmation, Promise.resolve("pending")]), "y", "the confirmation waits for Enter");
  terminal.enter();
  assert.equal(await confirmation, "y", "and the y belongs to the confirmation");
});

// ---------------------------------------------------------------- G. skipping

test("G: n after a pasted request skips it, and no part of the request becomes a prompt", async () => {
  const terminal = new Terminal();
  const answers: (string | null)[] = [];
  const request = terminal.input.ask("> ");
  terminal.paste("Change the label.\nThen run the tests.\n");
  await terminal.input.idle();
  terminal.enter();
  answers.push(await request);

  const confirmation = terminal.input.ask("  Run it? [y/N] ");
  terminal.type("n");
  terminal.enter();
  answers.push(await confirmation);
  assert.deepEqual(answers, ["Change the label.\nThen run the tests.\n", "n"]);

  // The next prompt starts empty: the confirmation's answer is not a request, and no line of the
  // pasted request was left queued for it.
  const next = terminal.input.ask("> ");
  await terminal.input.idle();
  terminal.type("/status");
  terminal.enter();
  assert.equal(await next, "/status");
});

test("G: a burst of request, confirmation, and next request stays three separate answers", async () => {
  const terminal = new Terminal();
  const request = terminal.input.ask("> ");
  terminal.paste("One line.\nTwo lines.\n");
  await terminal.input.idle();
  terminal.enter();
  assert.equal(await request, "One line.\nTwo lines.\n");

  // Everything below arrives while the confirmation is waiting, exactly as a fast operator types it.
  const confirmation = terminal.input.ask("  Run it? [y/N] ");
  terminal.type("y");
  terminal.enter();
  assert.equal(await confirmation, "y");

  const next = terminal.input.ask("> ");
  terminal.type("/policy direct");
  terminal.enter();
  assert.equal(await next, "/policy direct");
});

// ---------------------------------------------------------------- H. two pastes

test("H: two pastes before one Enter compose into a single request", async () => {
  const terminal = new Terminal();
  const { ask, all } = submissions(terminal);
  const pending = ask("> ");
  terminal.paste("First paragraph.\n");
  await terminal.input.idle();
  assert.deepEqual(all, [], "the first paste did not submit");
  terminal.paste("Second paragraph.\n");
  await terminal.input.idle();
  assert.deepEqual(all, [], "and neither did the second");

  terminal.enter();
  assert.equal(await pending, "First paragraph.\nSecond paragraph.\n", "both are in the draft, in order");
  assert.deepEqual(all, ["First paragraph.\nSecond paragraph.\n"]);
});

test("H: a paste split across chunks is still one paste", async () => {
  const terminal = new Terminal();
  const pending = terminal.input.ask("> ");
  // The kernel is free to split anywhere, including inside a marker and inside a multi-byte run.
  terminal.paste("line one\nline two", { splitAt: 4 });
  await terminal.input.idle();
  terminal.enter();
  assert.equal(await pending, "line one\nline two");
});

// ---------------------------------------------------------------- I. long paste

test("I: a very long paste is composed and submitted without any timing dependency", async () => {
  const terminal = new Terminal();
  const pending = terminal.input.ask("> ");
  const content = Array.from({ length: 400 }, (_, index) => `line ${String(index + 1)}`).join("\n");
  terminal.paste(`${content}\n`);
  await terminal.input.idle();
  terminal.enter();
  const answer = await pending;
  assert.equal(answer?.split("\n").length, 401);
  assert.equal(answer?.startsWith("line 1\nline 2\n"), true);
  assert.equal(answer?.endsWith("line 400\n"), true);
});

// ---------------------------------------------------------------- terminal behaviour

test("bracketed paste is enabled on a terminal, and disabled when it closes", async () => {
  const terminal = new Terminal();
  assert.match(terminal.written(), /\u001b\[\?2004h/, "the markers only arrive if the app asks for them");
  assert.deepEqual(terminal.rawModes, [true], "and the stream is taken over");
  terminal.close();
  assert.match(terminal.written(), /\u001b\[\?2004l/);
  assert.deepEqual(terminal.rawModes, [true, false]);
});

test("a pipe keeps line semantics and sends no escape sequences", async () => {
  // Not a terminal: nothing to enable, nothing to mark a paste, and one Enter is still one line.
  const terminal = new Terminal({ terminal: false });
  assert.doesNotMatch(terminal.written(), /2004/);
  assert.deepEqual(terminal.rawModes, []);
  const pending = terminal.input.ask("> ");
  terminal.type("hello");
  terminal.enter();
  assert.equal(await pending, "hello");
});

test("Ctrl+D on an empty draft ends the session; on a draft it does nothing", async () => {
  const terminal = new Terminal();
  const pending = terminal.input.ask("> ");
  terminal.type("half");
  terminal.chunk("\u0004");
  terminal.type(" a request");
  terminal.enter();
  assert.equal(await pending, "half a request");

  const second = terminal.input.ask("> ");
  terminal.chunk("\u0004");
  assert.equal(await second, null, "end of input releases the prompt rather than hanging it");
});

test("an ended input releases a waiting prompt", async () => {
  const terminal = new Terminal();
  const pending = terminal.input.ask("> ");
  terminal.end();
  assert.equal(await pending, null);
});

// ---------------------------------------------------------------- RTL and grapheme correctness
//
// The bug these exist for: Arabic typed into macOS Terminal was deleted one UTF-16 code unit at a
// time and erased one terminal cell at a time, and the screen kept showing letters that had been
// deleted. English hid both faults — a Latin letter is one code unit and one cell, laid out in
// logical order — so the tests below assert the logical buffer *and* the screen.

/** `مرحبا`, spelled out so it cannot be mangled by an editor, a copy, or a terminal. */
const MARHABA = "\u0645\u0631\u062D\u0628\u0627";

test("R: Arabic letters each delete as one character", () => {
  const letters = ["\u0645", "\u0631", "\u062D", "\u0628", "\u0627"];
  assert.equal(MARHABA, letters.join(""), "the fixture is the five letters it claims");
  for (const letter of letters) assert.equal(lastGrapheme(letter), letter);
  assert.equal(lastGrapheme("x" + MARHABA), "\u0627");
});

test("R: the splitter's fallback keeps code points whole, and never a lone surrogate", () => {
  // The fallback is what runs on an engine without `Intl.Segmenter`. It is not reachable from Node
  // (which always has one), so it is called directly — every case here is a character that must
  // delete as one unit, and the surrogate check is the invariant that must hold in every case.
  const cases = ["\u0645", "\u{1F600}", "\u{1F44D}\u{1F3FD}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u{1F1F8}\u{1F1E6}", "1\uFE0F\u20E3", "e\u0301"];
  for (const character of cases) {
    assert.equal(fallbackLastGrapheme(`ab${character}`), character, `${JSON.stringify(character)} is one character`);
  }
  assert.equal(fallbackLastGrapheme("\u0645\u064E"), "\u0645\u064E", "a letter and its fatha are one character");
  assert.equal(fallbackLastGrapheme("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"), "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}");
  assert.equal(fallbackLastGrapheme(""), "");
  for (const character of [...cases, "\u0645\u064E"]) {
    const removed = fallbackLastGrapheme(`ab${character}`);
    assert.equal(removed.includes("\uFFFD"), false);
    assert.equal(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(removed), false, `${JSON.stringify(removed)} is not half a pair`);
  }
});

test("A: typing Arabic sets the logical draft to exactly what was typed", async () => {
  const { terminal, screen } = displayTerminal();
  const { ask, all } = submissions(terminal);
  const pending = ask("> ");
  terminal.type(MARHABA);
  await terminal.input.idle();
  assert.deepEqual(all, [], "nothing is submitted before Enter");
  assert.equal(screen.screen(), `> ${MARHABA}`, "and the screen shows the draft that is held");
  terminal.enter();
  assert.equal(await pending, MARHABA, "the submitted request is the logical buffer, exactly");
});

test("B: five Backspaces take Arabic to the empty draft, one letter at a time", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  terminal.type(MARHABA);
  await terminal.input.idle();
  const expected = [MARHABA, "\u0645\u0631\u062D\u0628", "\u0645\u0631\u062D", "\u0645\u0631", "\u0645", ""];
  for (const [index, remaining] of expected.entries()) {
    if (index > 0) terminal.chunk("\u007f");
    await terminal.input.idle();
    // The screen is the assertion, not only the buffer: an erase that landed on the wrong cell left
    // the deleted letter visible, which is precisely the reported bug.
    assert.equal(screen.screen(), `> ${remaining}`, `after ${String(index)} deletions the screen shows exactly the draft`);
    assert.equal(screen.cursorRow(), `> ${remaining}`, "and the cursor is at the end of it");
  }
  terminal.enter();
  assert.equal(await pending, "", "Enter submits what remains, which is nothing");
});

test("B: deleting past the empty draft does nothing", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  terminal.type("\u0645");
  terminal.chunk("\u007f");
  terminal.chunk("\u007f");
  terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), "> ", "the display is not damaged by a Backspace on nothing");
  terminal.type("\u0631");
  terminal.enter();
  assert.equal(await pending, "\u0631");
});

test("C: Arabic with diacritics deletes the letter and its marks together", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  const marked = "\u0645\u064E\u0631\u0652\u062D\u064E\u0628\u064B\u0627"; // مَ رْ حَ بً ا
  terminal.type(marked);
  await terminal.input.idle();
  assert.equal(screen.screen(), `> ${marked}`);

  terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), "> \u0645\u064E\u0631\u0652\u062D\u064E\u0628\u064B", "the final letter goes, with both of its marks");
  terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), "> \u0645\u064E\u0631\u0652\u062D\u064E", "and the next one, with its fatha");
  terminal.chunk("\u007f");
  terminal.chunk("\u007f");
  terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), "> ");
  terminal.enter();
  assert.equal(await pending, "");
});

test("D: an emoji is one deletion, however many code points it is made of", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  // Delivered the way a terminal composes an emoji: base and modifier in one write. A modifier that
  // arrives in a chunk of its own is a modifier with no base yet, and it deletes as the one character
  // it currently is — `Intl.Segmenter` is right about that too, and the draft stays valid either way.
  terminal.chunk(`ship it \u{1F44D}\u{1F3FD}`);
  terminal.chunk(family);
  await terminal.input.idle();
  assert.equal(screen.screen(), `> ship it \u{1F44D}\u{1F3FD}${family}`, "every emoji is on screen as one character");

  terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), `> ship it \u{1F44D}\u{1F3FD}`, "the four-person ZWJ sequence goes in one Backspace");
  terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), "> ship it ", "and the thumbs up takes its skin tone with it");
  terminal.enter();
  assert.equal(await pending, "ship it ");
});

test("E: mixed-direction input mutates logically, one grapheme per Backspace", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  terminal.type("README " + MARHABA + " test");
  await terminal.input.idle();
  assert.equal(screen.screen(), `> README ${MARHABA} test`);

  const expected = [`README ${MARHABA} tes`, `README ${MARHABA} te`, `README ${MARHABA} t`, `README ${MARHABA} `, `README ${MARHABA}`, "README \u0645\u0631\u062D\u0628", "README \u0645\u0631\u062D", "README \u0645\u0631", "README \u0645", "README "];
  for (const [index, remaining] of expected.entries()) {
    terminal.chunk("\u007f");
    await terminal.input.idle();
    const label = `after ${String(index + 1)} deletions`;
    assert.equal(screen.screen(), `> ${remaining}`, `${label} the screen shows exactly the draft, in logical order`);
    assert.equal(screen.cursorRow(), `> ${remaining}`, `${label} and the cursor is at the end of the draft`);
  }
  terminal.enter();
  assert.equal(await pending, "README ", "the request is what is left, exactly — Latin then Arabic, in order");
});

test("F: an Arabic multiline paste keeps its lines and its order", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  const content = "\u0645\u0631\u062D\u0628\u0627\n\u062C\u0631\u0628 \u062A\u0639\u062F\u064A\u0644 \u0627\u0644\u0645\u0644\u0641\n\u0644\u0627 \u062A\u0639\u0645\u0644 commit";
  terminal.paste(content.replace(/\n/g, "\r"), { splitAt: 5 });
  await terminal.input.idle();
  // Three lines, in order, once — rendered as the lines they are. Nothing is folded, truncated or
  // announced: a multiline draft looks like a multiline draft.
  assert.equal(screen.screen(), `> ${content}`, "the draft is shown as its own lines, in order, once");
  terminal.enter();
  assert.equal(await pending, content, "the pasted text is the draft, normalised once");
});

test("G: Backspace after an Arabic paste edits the logical draft", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  // Two different words, so what was deleted is visible in what remains.
  const first = "\u0645\u0631\u062D\u0628\u0627";
  const second = "\u062C\u0631\u0628";
  terminal.paste(`${first}\n${second}`);
  await terminal.input.idle();
  terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), `> ${first}\n\u062C\u0631`, "the last letter of the last line goes");
  terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), `> ${first}\n\u062C`, "and the next, on the same line");
  terminal.chunk("\u007f");
  terminal.chunk("\u007f");
  await terminal.input.idle();
  // The fourth deletion crossed the pasted newline. The draft is one line now, so the notice must go
  // with the line it was counting, and nothing of the second line may remain on screen.
  assert.equal(screen.screen(), `> ${first}`, "deleting the newline takes the second line and its notice with it");
  terminal.enter();
  assert.equal(await pending, first);
});

test("H: an Arabic paste and a Backspace submit exactly the normalised draft", async () => {
  const { terminal } = displayTerminal();
  const { ask, all } = submissions(terminal);
  const pending = ask("> ");
  terminal.paste("\u0645\u0631\u062D\u0628\u0627\r\n\u0644\u0627 \u062A\u0639\u0645\u0644 commit\r\n");
  await terminal.input.idle();
  terminal.chunk("\u007f");
  terminal.chunk("\u007f");
  terminal.enter();
  const expected = "\u0645\u0631\u062D\u0628\u0627\n\u0644\u0627 \u062A\u0639\u0645\u0644 commi";
  assert.equal(await pending, expected, "the submitted request is the draft after two graphemes were removed");
  assert.deepEqual(all, [expected], "and it is submitted once");
  assert.doesNotMatch(expected, /\r/, "with no carriage return left in it");
});

test("I: Ctrl+C clears an Arabic draft without submitting any of it", async () => {
  const { terminal, screen } = displayTerminal();
  const { ask, all } = submissions(terminal);
  const pending = ask("> ");
  terminal.type(MARHABA);
  await terminal.input.idle();
  terminal.chunk("\u0003");
  await terminal.input.idle();
  assert.deepEqual(all, [], "Ctrl+C is not a submit");
  assert.equal(screen.cursorRow(), "> ", "the displayed draft is empty again");
  terminal.type("\u0644\u0627");
  terminal.enter();
  assert.equal(await pending, "\u0644\u0627", "and what is typed afterwards is what is submitted");
});

test("J: every edit repaints from the terminal's anchor, and never erases above it", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  terminal.type(MARHABA + MARHABA);
  for (let index = 0; index < 5; index += 1) terminal.chunk("\u007f");
  await terminal.input.idle();

  const bytes = screen.bytes();
  // The old renderer's whole mechanism, asserted gone: move the cursor left one cell, write a space,
  // move it left again. It is only correct for single-cell left-to-right text, and that assumption is
  // what produced the first corruption. A Backspace byte is input, never output, so its absence is
  // also the check that nothing is erased in place.
  assert.equal(bytes.includes("\u007f \u007f"), false, "no in-place cell erase is emitted");
  assert.doesNotMatch(bytes, /\u007f/, "and no erase byte is written to the terminal at all");
  assert.doesNotMatch(bytes, /\u001b\[[0-9]*D/, "nor a cursor-left");

  // The mechanism now: restore the anchor, erase downwards, reprint the buffer, place the cursor.
  // One anchor-save per prompt, one restore per edit, and every erase starting exactly at the anchor
  // — which is where the prompt ended, so nothing above it can be touched.
  // One save when the prompt is written, and one more per edit — on the same row and column, after
  // room for the region has been made by exact relative moves, so a scroll cannot leave it stale.
  assert.equal(bytes.split("\u001b7").length - 1, 1 + 15, "the anchor is saved with the prompt and re-saved by each of the fifteen edits");
  assert.equal(bytes.split("\u001b8").length - 1, 30, "and restored twice per edit: once to make room, once to place the cursor");
  assert.equal(screen.eraseStarts().length, 15, "each restore is followed by one erase");
  for (const start of screen.eraseStarts()) {
    assert.equal(start.row, 0, "every erase starts on the prompt's own row");
    assert.equal(start.column, 2, "at the column the prompt ended, never before it");
  }
  assert.equal(screen.screen(), `> ${MARHABA}`, "and the screen is the buffer as it stands");
  terminal.enter();
  assert.equal(await pending, MARHABA);
});

// ---------------------------------------------------------------- the dogfood paste, exactly

/**
 * The two failures the dogfood session actually produced.
 *
 * The request below is the one from the session, and it arrived from macOS Terminal with CR for
 * every pasted newline. The old composer kept them, so the stored goal objective contained `\r\r`
 * where its blank lines were — and every renderer that follows honoured the CR, returning the cursor
 * to column 0 and writing the next line *over* the previous one. `/goal` then displayed a sentence
 * that had never been typed ("…reversible DIRECT-mod" + "3. one harmless…"), and the operator could
 * not tell whether the draft matched what was pasted.
 *
 * So: the draft is the pasted text with its line endings normalised, nothing else, and the display
 * is the draft rather than a re-rendering of it.
 */
const DOGFOOD_REQUEST = [
  "Inspect this repository and identify one small, easy-to-understand source file or documentation file that would be safe to use for a reversible DIRECT-mode test.",
  "",
  "Do not modify anything yet.",
  "",
  "Tell me:",
  "1. which file you selected,",
  "2. why it is safe for this disposable test,",
  "3. one harmless comment-only change we could make later.",
].join("\n");

test("P: the dogfood paste composes into exactly the text that was pasted", async () => {
  const terminal = new Terminal();
  const pending = terminal.input.ask("> ");
  // Delivered the way the terminal delivered it: CR line endings, in three chunks.
  const framed = `${PASTE_START}${DOGFOOD_REQUEST.replace(/\n/g, "\r")}${PASTE_END}`;
  terminal.chunk(framed.slice(0, 60));
  terminal.chunk(framed.slice(60, 200));
  terminal.chunk(framed.slice(200));
  await terminal.input.idle();
  terminal.enter();
  const answer = await pending;
  assert.equal(answer, DOGFOOD_REQUEST, "CR and CRLF become newlines; everything else is untouched");
  assert.doesNotMatch(answer ?? "", /\r/, "no carriage return survives into the draft");
  assert.match(answer ?? "", /\n\nDo not modify anything yet\.\n\nTell me:\n1\. which file you selected,\n2\. /, "blank lines and numbers survive in order");
});

test("Q: the display shows the pasted draft rather than a re-rendering of it", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  // Delivered the way macOS Terminal delivered it: CR for every newline.
  terminal.paste(DOGFOOD_REQUEST.replace(/\n/g, "\r"));
  await terminal.input.idle();
  // Every line of the draft is on screen, in order, once. Before the composer normalised pasted line
  // endings this is what broke: the CRs were kept, so each line was written over the one before it and
  // the operator read a sentence that had never been typed.
  // The whole paste, on its own lines, exactly as it arrived.
  assert.equal(screen.screen(), `> ${DOGFOOD_REQUEST}`, "the draft is the pasted text, line for line");
  assert.equal(screen.screen().indexOf("1. which file you selected,") > screen.screen().indexOf("Tell me:"), true, "the list appears in order");
  assert.equal(screen.screen().indexOf("3. one harmless") > screen.screen().indexOf("2. why it is safe"), true);
  // A CR the composer writes is positioning its own output. A CR inside the *draft* is content, and
  // every renderer downstream honours it: `/goal` spliced two paragraphs of a real objective this way.
  assert.doesNotMatch(DOGFOOD_REQUEST, /\r/);
  terminal.enter();
  assert.equal(await pending, DOGFOOD_REQUEST);
});

test("a long paste keeps its order, its blank lines and its trailing newline", async () => {
  const terminal = new Terminal();
  const pending = terminal.input.ask("> ");
  const long = Array.from({ length: 200 }, (_, index) => (index % 7 === 0 ? "" : `line ${String(index + 1)}.`)).join("\r\n") + "\r\n";
  terminal.paste(long);
  await terminal.input.idle();
  terminal.enter();
  const answer = await pending;
  assert.equal(answer, long.replace(/\r\n/g, "\n"), "the whole paste, normalised once");
  assert.equal(answer?.startsWith("\nline 2."), true, "the first blank line is where it was");
  assert.equal(answer?.endsWith("line 200.\n"), true);
});

test("two consecutive pastes keep their order and submit as one draft", async () => {
  const terminal = new Terminal();
  const pending = terminal.input.ask("> ");
  terminal.paste("first\r\nblock\r\n");
  await terminal.input.idle();
  terminal.paste("second\r\nblock\r\n");
  await terminal.input.idle();
  terminal.enter();
  assert.equal(await pending, "first\nblock\nsecond\nblock\n");
});

test("the request that reaches the caller is the composed draft, exactly", async () => {
  const terminal = new Terminal();
  const pending = terminal.input.ask("> ");
  terminal.paste(`${DOGFOOD_REQUEST}\r\n`);
  await terminal.input.idle();
  terminal.enter();
  const delivered = await pending;
  // This string is what the REPL stores as the conversation turn, the task request and the goal's
  // objective. It is the draft; nothing downstream re-derives or trims it.
  assert.equal(delivered, `${DOGFOOD_REQUEST}\n`);
});

// ---------------------------------------------------------------- history is never touched

/**
 * The defect this section exists for, in the operator's words: "I paste multiline text, press
 * Backspace repeatedly, and the terminal display becomes corrupted — it can visually continue
 * deleting text that belongs to earlier BrainGate output."
 *
 * It did. The composer kept an anchor counted as `lines + notice`, which is not the number of rows a
 * draft occupies: a four-line draft moved the cursor up eight rows, and every redraw after that
 * cleared from several rows above the draft — inside the run's own output — and reprinted. Deleting
 * the draft walked that erase further up the screen, so the operator watched history disappear line
 * by line.
 *
 * The composer now owns exactly one row and never moves the cursor off it, so these tests assert the
 * invariant directly: whatever was on screen before the prompt is still there afterwards, byte for
 * byte, however the draft is edited. They fail against the old renderer and cannot be satisfied by
 * arithmetic that happens to be right for one terminal width.
 */

/** Some output of the kind a run prints before the next prompt. */
function printRunOutput(screen: VirtualTerminal): string {
  screen.write("Dogfood preflight m21: ask=ready · write=ready · configured=10 · model calls=0\r\n");
  screen.write("  read-only · direct · in your workspace · T1/low · primary=anthropic/claude-sonnet-5\r\n");
  screen.write("Task 11111111-2222-3333-4444-555555555555 · observed=1 · outcome=SUCCESS\r\n");
  screen.write("  session: new native session abc12345\r\n");
  return screen.screen();
}

const MULTILINGUAL_DRAFT = [
  "english line",
  "سطر عربي للاختبار",
  "emoji: 👩‍💻🚀",
  "another long line that wraps in a normal terminal width — ".repeat(3).trimEnd(),
].join("\n");

test("H1: deleting a pasted multilingual draft leaves every earlier line intact", async () => {
  const { terminal, screen } = displayTerminal({ columns: 60 });
  const history = printRunOutput(screen);
  const pending = terminal.input.ask("> ");
  terminal.paste(MULTILINGUAL_DRAFT);
  await terminal.input.idle();
  const whilePasted = screen.screen();
  assert.notEqual(whilePasted, history, "the draft is on screen");

  // Delete the whole draft, then keep pressing Backspace.
  for (let index = 0; index < 400; index += 1) terminal.chunk("\u007f");
  await terminal.input.idle();

  const after = screen.screen();
  assert.equal(history.split("\n").every((line) => after.includes(line)), true, `every earlier line is still present\n${after}`);
  assert.equal(after.endsWith(`> `) || after.endsWith(">"), true, `and the prompt is on the last row, empty\n${JSON.stringify(after.slice(-40))}`);
  assert.equal(after.includes("سطر"), false, "no stale Arabic remains");
  assert.equal(after.includes("👩"), false, "and no broken emoji grapheme remains");
  // The mechanism's own guarantee, in the terminal's terms: every erase began at *one* anchor, that
  // anchor is the spot just after the prompt, and the row it sits on is the prompt's row — so no
  // erase ever began above the region the composer owns.
  const anchors = new Set(screen.eraseStarts().map((start) => `${String(start.row)}:${String(start.column)}`));
  assert.equal(anchors.size, 1, `every erase starts at the same anchor: ${[...anchors].join(", ")}`);
  const anchor = screen.eraseStarts()[0]!;
  assert.equal(after.split("\n")[anchor.row]?.startsWith("> ") ?? false, true, "and that anchor is on the prompt's row");
  assert.equal(anchor.column, 2, "just after the prompt text, never before it");
  assert.doesNotMatch(screen.bytes(), /\u007f/, "and nothing is ever erased in place");

  // The prompt still works: type a request, submit it once.
  terminal.type("second request");
  terminal.enter();
  assert.equal(await pending, "second request", "typing after the deletions works, and submits once");
});

test("H2: the earlier output is byte-for-byte identical after the whole edit sequence", async () => {
  const { terminal, screen } = displayTerminal({ columns: 60 });
  const history = printRunOutput(screen);
  const pending = terminal.input.ask("> ");
  terminal.paste(MULTILINGUAL_DRAFT);
  await terminal.input.idle();
  terminal.chunk("\u007f".repeat(30));           // delete part of the last line
  terminal.type("replacement tail");             // type something new
  await terminal.input.idle();
  terminal.chunk("\u007f".repeat(60));           // delete that and more
  terminal.type("final");
  await terminal.input.idle();
  terminal.chunk("\u007f".repeat(200));          // delete the rest, then keep going
  await terminal.input.idle();

  const rows = screen.screen().split("\n");
  assert.deepEqual(rows.slice(0, history.split("\n").length), history.split("\n"), "the run's own output, unchanged and unmoved");
  assert.equal(screen.cursorRow().startsWith(">"), true, "the cursor is on the prompt row");
  terminal.enter();
  assert.equal(await pending, "", "the draft was fully deleted, so Enter submits an empty request");
});

test("H3: an Arabic-only paste deletes to empty, and extra Backspaces are a no-op", async () => {
  const { terminal, screen } = displayTerminal({ columns: 60 });
  const history = printRunOutput(screen);
  const pending = terminal.input.ask("> ");
  const arabic = "مرحبا بالعالم";
  terminal.paste(arabic);
  await terminal.input.idle();
  for (let index = 0; index < arabic.length; index += 1) terminal.chunk("\u007f");
  await terminal.input.idle();
  const emptied = screen.screen();
  const before = screen.bytes().length;
  for (let index = 0; index < 25; index += 1) terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), emptied, "Backspace on an empty draft changes nothing on screen");
  assert.equal(screen.bytes().length, before, "and writes no bytes at all — not even a redraw");
  assert.equal(emptied.includes(history), true, "the earlier output survived the whole sequence");
  terminal.enter();
  assert.equal(await pending, "", "an empty draft submits as empty");
});

test("H4: a long line wraps like any terminal line, in full, and the prompt stays on its first row", async () => {
  const columns = 40;
  const { terminal, screen } = displayTerminal({ columns });
  const pending = terminal.input.ask("> ");
  const long = "a line long enough that a terminal must wrap it more than once, twice over";
  terminal.paste(long);
  await terminal.input.idle();
  const rows = screen.screen().split("\n");
  const expected = Math.ceil((long.length + 2) / columns);
  assert.equal(rows.length, expected, `the line wraps onto ${String(expected)} rows, as the terminal does`);
  assert.equal(rows[0]!.startsWith("> a line long"), true, "and the prompt stays on the first row");
  assert.equal(rows.join(""), `> ${long}`, "with every character present, in order, once");
  terminal.enter();
  assert.equal(await pending, long, "and the buffer is the text, not the wrapped rendering of it");
});

test("H4b: the cursor is placed where the cursor is, in a wrapped draft", async () => {
  const columns = 20;
  const { terminal, screen } = displayTerminal({ columns });
  const pending = terminal.input.ask("> ");
  terminal.paste("first line\nsecond line that wraps onto another row");
  await terminal.input.idle();
  // End of the buffer: on the last wrapped row, at the end of the text.
  assert.equal(screen.cursorRow().endsWith("another row"), true, `the cursor is at the end of the buffer: ${JSON.stringify(screen.cursorRow())}`);
  // Up one line: the cursor keeps its column, so it lands in the middle of the first line.
  terminal.chunk("\u001b[A");
  await terminal.input.idle();
  assert.equal(screen.cursorRow().startsWith("> first line"), true, `up moves a line: ${JSON.stringify(screen.cursorRow())}`);
  // Home, then Down: the column is remembered as the first line's offset.
  terminal.chunk("\u001b[H");
  await terminal.input.idle();
  assert.equal(screen.cursorRow().startsWith("> first line"), true, "home goes to the start of the line");
  terminal.chunk("\u001b[B");
  await terminal.input.idle();
  assert.equal(screen.cursorRow().startsWith("second line"), true, `down moves a line: ${JSON.stringify(screen.cursorRow())}`);
  terminal.enter();
  assert.equal(await pending, "first line\nsecond line that wraps onto another row");
});

test("H5: a submitted multiline draft is echoed in full, as output below the composer's row", async () => {
  const { terminal, screen } = displayTerminal({ columns: 200 });
  const history = printRunOutput(screen);
  const pending = terminal.input.ask("> ");
  terminal.paste(MULTILINGUAL_DRAFT);
  await terminal.input.idle();
  terminal.enter();
  assert.equal(await pending, MULTILINGUAL_DRAFT);
  const after = screen.screen();
  assert.equal(after.includes(history), true, "what ran before is still there");
  for (const line of MULTILINGUAL_DRAFT.split("\n")) {
    assert.equal(after.includes(line), true, `the submitted draft is on screen: ${line.slice(0, 30)}`);
  }
});

// ---------------------------------------------------------------- editing inside the draft

/**
 * The composer is an editor, so these tests are about editing rather than about pasting.
 *
 * The old model could only append and delete at the end — a deliberate limitation, because a cursor
 * above shaped text was a guess about where a character sits on screen. With the region anchored by
 * the terminal, a cursor is just an index into the buffer, and the movements a person expects are
 * implementable without any such guess: the buffer is the truth, the redraw is bounded, and the only
 * thing that can be approximately placed is the cursor itself, inside its own region.
 */

test("N1: Left and Right move by grapheme, and typing inserts where the cursor is", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  terminal.paste("the quick brown fox");
  await terminal.input.idle();
  // Nine graphemes back from the end is the start of "brown": "fox", the space, and "brown".
  for (let index = 0; index < 9; index += 1) terminal.chunk("\u001b[D");
  terminal.type("very ");
  await terminal.input.idle();
  assert.equal(screen.screen(), "> the quick very brown fox", "the word is inserted where the cursor was");
  terminal.enter();
  assert.equal(await pending, "the quick very brown fox", "and that is what is submitted");
});

test("N2: Home and End work inside the current line, not the whole buffer", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  terminal.paste("first line\nsecond line");
  await terminal.input.idle();
  terminal.chunk("\u001b[H");   // Home: start of the *second* line
  terminal.type("(edited) ");
  await terminal.input.idle();
  assert.equal(screen.screen(), "> first line\n(edited) second line", "Home went to the start of the cursor's line");
  terminal.chunk("\u001b[F");   // End: end of the same line
  terminal.type(" too");
  await terminal.input.idle();
  assert.equal(screen.screen(), "> first line\n(edited) second line too", "End went to the end of that line");
  terminal.enter();
  assert.equal(await pending, "first line\n(edited) second line too");
});

test("N3: Up and Down keep the column, and stop at the ends", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  terminal.paste("alpha bravo\ncharlie delta\n\necho");
  await terminal.input.idle();
  terminal.chunk("\u001b[A");   // up one: onto the empty line (column 0, so the line is empty)
  terminal.chunk("\u001b[A");   // up again: line 2
  terminal.type("X");
  await terminal.input.idle();
  assert.equal(screen.screen().split("\n")[1], "Xcharlie delta", "the cursor kept its column and inserted there");
  // Up once more is line 1, keeping the column it had (one past the "a" it inserted "X" at); up
  // again is a no-op, not a wrap to the end of the buffer.
  terminal.chunk("\u001b[A");
  terminal.chunk("\u001b[A");
  terminal.type("Y");
  await terminal.input.idle();
  assert.equal(screen.screen().split("\n")[0], "> aYlpha bravo", "up stops at the first line, at the column it kept");
  terminal.enter();
  assert.equal(await pending, "aYlpha bravo\nXcharlie delta\n\necho");
});

test("N4: Delete removes the grapheme at the cursor, not the one before it", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  const emoji = "ship it 👍🏽👨‍👩‍👧‍👦";
  terminal.paste(emoji);
  await terminal.input.idle();
  terminal.chunk("\u001b[D");    // one grapheme left: the cursor is before the family sequence
  await terminal.input.idle();
  terminal.chunk("\u001b[3~");   // Delete: the family, however many code points it is made of
  await terminal.input.idle();
  assert.equal(screen.screen(), "> ship it 👍🏽", "the whole ZWJ sequence went in one Delete");
  // Delete acts *at* the cursor, which is now at the end of the buffer — so remove the skin-tone
  // emoji the way a person would: step left over it, then Delete.
  terminal.chunk("\u001b[D");
  terminal.chunk("\u001b[3~");
  await terminal.input.idle();
  assert.equal(screen.screen(), "> ship it ", "and the skin-tone emoji next");
  terminal.enter();
  assert.equal(await pending, "ship it ");
});

test("N5: Backspace in the middle of Arabic deletes the letter under it, with its marks", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  const word = "مَرْحَبًا";
  terminal.paste(word);
  await terminal.input.idle();
  // The expectation is built from the same grapheme rules the composer deletes by, rather than from
  // a hand-count of code points: "مَرْحَبًا" clusters as [مَ][رْ][حَ][بً][ا] — the fathatan attaches to
  // the ب and the ا after it is a cluster of its own. One step left, two Backspaces, so the two
  // clusters before the cursor's neighbour are the ones that go.
  const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word)].map((part) => part.segment);
  const expected = `${parts[0] ?? ""}${parts[1] ?? ""}${parts[4] ?? ""}`;
  terminal.chunk("\u001b[D");
  terminal.chunk("\u007f");
  terminal.chunk("\u007f");
  await terminal.input.idle();
  terminal.enter();
  assert.equal(await pending, expected, "exactly two graphemes went, marks and all");
});

test("N6: Backspace at the very beginning is a no-op that writes nothing", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  terminal.type("abc");
  await terminal.input.idle();
  terminal.chunk("\u001b[H");     // Home: cursor at the very start
  await terminal.input.idle();
  const before = screen.bytes().length;
  for (let index = 0; index < 10; index += 1) terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.bytes().length, before, "ten Backspaces at the start wrote nothing at all");
  assert.equal(screen.screen(), "> abc", "and the buffer is unchanged");
  terminal.enter();
  assert.equal(await pending, "abc");
});

test("N7: a word can be changed in the middle of a long pasted prompt", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  const request = "Summarize the release notes and do not modify anything.";
  terminal.paste(request);
  await terminal.input.idle();
  // Walk back to the start of "anything" and replace the word: the case the operator described.
  // Nine graphemes back is the "a"; eight Deletes remove the word, leaving the full stop.
  for (let index = 0; index < 9; index += 1) terminal.chunk("\u001b[D");
  for (let index = 0; index < "anything".length; index += 1) terminal.chunk("\u001b[3~");
  terminal.type("the file");
  await terminal.input.idle();
  assert.equal(screen.screen(), "> Summarize the release notes and do not modify the file.", "the word is replaced in place");
  terminal.enter();
  assert.equal(await pending, "Summarize the release notes and do not modify the file.");
});

// ---------------------------------------------------------------- a real pseudo-terminal

/**
 * The whole manual flow, on a real pseudo-terminal rather than a mocked key stream.
 *
 * Everything above drives `createPromptInput` in-process, which is exact about the composer and says
 * nothing about what a terminal does with the bytes. This runs it on a genuine PTY (`script`), sends
 * the keystrokes an operator sent — a wrapped multilingual paste, arrow keys, Home/End, Delete,
 * word replacement, deleting the buffer to empty, extra Backspaces, then a new request — interprets
 * the captured output with the same emulator, and asserts both what was submitted and what a person
 * would have seen.
 *
 * Skipped where `script` is unavailable.
 */
const TSX_IMPORT = import.meta.resolve("tsx");

test("PTY: pasting, navigating, editing and deleting on a real terminal", { skip: process.platform === "darwin" ? false : "POSIX `script` only" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-pty-"));
  const driver = join(root, "driver.mts");
  writeFileSync(driver, `import { createPromptInput } from ${JSON.stringify(new URL("./prompt-input.ts", import.meta.url).pathname)};
const write = (text) => { process.stdout.write(text); };
// A watchdog, so a stuck PTY fails the test instead of hanging it: the suite runs many files at
// once, and a driver that never returns would otherwise sit until the spawn timeout.
setTimeout(() => { write("\\r\\nDRIVER-TIMEOUT\\r\\n"); process.exit(3); }, 25_000).unref();
write("history one: preflight ask=ready · write=ready\\r\\n");
write("history two: Task 11111111-2222-3333-4444-555555555555 · outcome=SUCCESS\\r\\n");
const input = createPromptInput({ input: process.stdin, write, terminal: true, columns: 60 });
const first = await input.ask("> ");
write("\\r\\nFIRST[" + JSON.stringify(first) + "]\\r\\n");
const second = await input.ask("> ");
write("\\r\\nSECOND[" + JSON.stringify(second) + "]\\r\\n");
input.close();
process.exit(0);
`);
  const ESC = "\u001b";
  const keys = [
    `${PASTE_START}${MULTILINGUAL_DRAFT}${PASTE_END}`,
    // Navigate inside the draft and change a word: up one line (to the emoji line), Home, Delete the
    // "emoji: " label a grapheme at a time, and type a replacement in its place.
    `${ESC}[A`, `${ESC}[H`, `${ESC}[3~`.repeat(7),
    "(edited) ",
    // Now the second ask: paste again, delete the whole buffer, keep pressing Backspace, type anew.
    `\r`,
    `${PASTE_START}سطر عربي فقط${PASTE_END}`,
    "\u007f".repeat(60),
    "final request",
    "\r",
  ].join("");
  const keyFile = join(root, "keys.bin");
  writeFileSync(keyFile, keys, "utf8");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    // Delayed, like a person: the tty echoes input until the composer puts it in raw mode, and keys
    // written before the driver starts are echoed by the kernel rather than composed by BrainGate.
    // Three seconds, because the whole suite runs its files at once and a driver can be slow to
    // start; the driver's own watchdog is what keeps a stuck pty from hanging the run.
    const result = spawnSync("/bin/sh", ["-c", `{ sleep 3; cat ${quote(keyFile)}; } | script -q /dev/null ${quote(process.execPath)} --import ${quote(TSX_IMPORT)} ${quote(driver)}`], {
      encoding: "buffer",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `driver exited cleanly: ${String(result.stderr).slice(0, 300)}`);
    const screen = new VirtualTerminal();
    screen.write(result.stdout.toString("utf8"));
    const shown = screen.screen();

    // What was submitted, through a real terminal, after the edits.
    // The expectation is built from the same draft the driver pasted, with the one edit the keys
    // make to it — rather than a hand-copied string that has to be kept in step with the fixture.
    const expectedFirst = MULTILINGUAL_DRAFT.replace("emoji: 👩‍💻🚀", "(edited) 👩‍💻🚀");
    assert.equal(shown.includes(`FIRST[${JSON.stringify(expectedFirst)}]`), true, `the edited buffer was submitted\n${shown.slice(-600)}`);
    assert.equal(shown.includes(`SECOND["final request"]`), true, `and the request typed after deleting everything\n${shown.slice(-300)}`);

    // The operator's earlier output is still there, and nothing of the drafts is.
    assert.equal(shown.includes("history one: preflight ask=ready · write=ready"), true, "the first line of history survived");
    assert.equal(shown.includes("history two: Task 11111111"), true, "and the second");
    // What follows the second answer is the session after both drafts were dealt with: no draft text
    // may be sitting on the screen there. (The first request itself is echoed above, emoji and all —
    // that is the request the operator sent, not a leftover.)
    const afterSecond = shown.slice(shown.indexOf("SECOND["));
    assert.equal(afterSecond.includes("👩"), false, "no stale emoji is left on the screen");
    assert.equal(afterSecond.includes("سطر"), false, "and no stale Arabic");
    assert.equal(afterSecond.includes("(edited)"), false, "and nothing of the first draft");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W2: the classifier receives exactly the visible buffer, after paste, navigation and deletion", async () => {
  // The composer is an editor, so the text a request is classified from has to be the text on screen.
  // A stale hidden buffer — a fragment kept past the deletion, a line the display dropped — would be
  // classified, and the operator would be shown a mode for a request they cannot see.
  const { terminal, screen } = displayTerminal({ columns: 60 });
  const pending = terminal.input.ask("> ");
  terminal.paste("Explain the payment migration.\nAlso delete README.md?");
  await terminal.input.idle();
  // Navigate to the end of the first line and edit it, then delete the second line entirely: the
  // result is a plain read, and it must be classified as one.
  terminal.chunk("\u001b[A");
  terminal.chunk("\u001b[F");
  terminal.chunk("\u001b[3~".repeat("? \nAlso delete README.md".length));
  await terminal.input.idle();
  const visible = screen.screen().replace(/^> /, "").replace(/\n/g, "\n");
  terminal.enter();
  const submitted = await pending;
  assert.equal(submitted, visible, "what was submitted is what was on screen");
  assert.equal(submitted.trim(), "Explain the payment migration.", "and the deletion took effect in the buffer");
  assert.equal(classifyRequestIntent(submitted), "read", "a question about payments is not a write request");

  // The same flow, ending in a real instruction: it must be a write, and again from the visible text.
  const { terminal: second, screen: secondScreen } = displayTerminal({ columns: 60 });
  const secondPending = second.input.ask("> ");
  second.paste("Explain the auth flow.\nDelete the temporary file.");
  await second.input.idle();
  second.chunk("\u001b[A");
  second.chunk("\u001b[H");
  second.chunk("\u001b[3~".repeat("Explain the auth flow.\n".length));
  await second.input.idle();
  const secondVisible = secondScreen.screen().replace(/^> /, "");
  second.enter();
  const secondSubmitted = await secondPending;
  assert.equal(secondSubmitted, secondVisible, "what was submitted is what was on screen");
  assert.equal(secondSubmitted.trim(), "Delete the temporary file.", "the instruction is what remains");
  assert.equal(classifyRequestIntent(secondSubmitted), "write", "and it is a write");
});
