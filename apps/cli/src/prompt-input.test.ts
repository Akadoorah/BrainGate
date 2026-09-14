import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createPromptInput, displayWidth, fallbackLastGrapheme, lastGrapheme, PASTE_END, PASTE_START, type PromptInput } from "./prompt-input.js";
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

  constructor(options: { readonly terminal?: boolean; readonly onWrite?: (text: string) => void; readonly columns?: number } = {}) {
    this.input = createPromptInput({
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
      if (rest.startsWith("\u001b[1B")) {
        this.#row += 1;
        this.#column = 0;
        index += 4;
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
        // row below it is gone. This is the whole mechanism the redraw relies on.
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
      if (char === "\n") { this.#row += 1; this.#column = 0; index += 1; continue; }
      const point = String.fromCodePoint(text.codePointAt(index)!);
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
}

/** A terminal that both records bytes and displays them. */
function displayTerminal(options: { readonly columns?: number } = {}): { readonly terminal: Terminal; readonly screen: VirtualTerminal } {
  const screen = new VirtualTerminal();
  const terminal = new Terminal({ onWrite: (text) => { screen.write(text); }, ...(options.columns === undefined ? {} : { columns: options.columns }) });
  return { terminal, screen };
}

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
  assert.match(terminal.written(), /pasted 2 lines — Enter sends, Ctrl\+C clears/, "and the operator is told it is pending");

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
  // One row, with the line breaks shown as `↵`. The buffer still holds three lines — asserted below —
  // and the row is the whole draft as far as the width allows, which is what keeps the cursor on a row
  // whose height this module does not have to count.
  assert.equal(screen.screen(), `> ${content.replace(/\n/g, "\u21b5")}  [pasted 3 lines — Enter sends, Ctrl+C clears]`, "the draft is on one row, in order, once");
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
  // The notice is part of the render, not a line written once: it is reprinted with the draft, so it
  // can never become a stale suffix, and it is still true — the draft is still the pasted text.
  const notice = "  [pasted 2 lines — Enter sends, Ctrl+C clears]";
  terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), `> ${first}\u21b5\u062C\u0631${notice}`, "the last letter of the last line goes");
  terminal.chunk("\u007f");
  await terminal.input.idle();
  assert.equal(screen.screen(), `> ${first}\u21b5\u062C${notice}`, "and the next, on the same line");
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

test("J: every edit is a one-row redraw, and the cursor is never moved up", async () => {
  const { terminal, screen } = displayTerminal();
  const pending = terminal.input.ask("> ");
  terminal.type(MARHABA + MARHABA);
  for (let index = 0; index < 5; index += 1) terminal.chunk("\u007f");
  await terminal.input.idle();

  const bytes = screen.bytes();
  // The old renderer's whole mechanism, asserted gone: move the cursor left one cell, write a space,
  // move it left again. It is only correct for single-cell left-to-right text, and that assumption is
  // what produced the bug. A Backspace byte is input, never output, so its absence is also the check
  // that nothing is erased in place.
  assert.equal(bytes.includes("\u007f \u007f"), false, "no in-place cell erase is emitted");
  assert.doesNotMatch(bytes, /\u007f/, "and no erase byte is written to the terminal at all");
  assert.doesNotMatch(bytes, /\u001b\[[0-9]*D/, "nor a cursor-left");

  // And the newer mechanism's own hazard, asserted gone as well: the cursor never leaves the row the
  // composer owns. No cursor-up, no cursor-down, and no erase-to-end-of-display — the three bytes that
  // together let a mis-counted anchor delete the operator's history.
  assert.doesNotMatch(bytes, /\u001b\[[0-9]*A/, "the cursor is never moved up");
  assert.doesNotMatch(bytes, /\u001b\[1B/, "nor down off the draft's row");
  assert.doesNotMatch(bytes, /\u001b\[J/, "nor is anything erased below this row");

  // Each deletion cleared its own row and reprinted the draft: one erase-line per edit — ten
  // characters typed one byte at a time, then five Backspaces — and no render that reprints only part
  // of the draft. Nothing incremental is attempted anywhere in the stream.
  assert.equal(bytes.split("\u001b[2K").length - 1, 15, "one row redraw per edit, and nothing else");
  assert.equal(screen.screen(), `> ${MARHABA}`, "and the row is the draft as it stands, with no stale suffix");
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
  // One row: the draft's tail as far as the default width allows, its line breaks shown, and the count
  // of lines it holds. The full text is asserted where it belongs — in what is submitted.
  const shown = DOGFOOD_REQUEST.replace(/\n/g, "\u21b5");
  const row = screen.screen();
  assert.equal(row.startsWith("> "), true);
  assert.equal(row.endsWith("  [pasted 8 lines — Enter sends, Ctrl+C clears]"), true, `the line count is on the row: ${row}`);
  assert.equal(row.includes("\u21b5"), true, "and the line breaks are visible as such");
  const draftOnRow = row.slice(2, row.indexOf("  [pasted"));
  assert.equal(shown.endsWith(draftOnRow.startsWith("\u2026") ? draftOnRow.slice(1) : draftOnRow), true, "what is shown is the tail of the draft, not a re-rendering of it");
  assert.equal(draftOnRow.endsWith("later."), true, "and the end of the draft is what stayed visible, because that is where the cursor is");
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
  const bytes = screen.bytes();
  assert.doesNotMatch(bytes, /\u001b\[[0-9]*A/, "the cursor was never moved up");
  assert.doesNotMatch(bytes, /\u001b\[J/, "and nothing below the composer's row was ever erased");

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

test("H4: the draft's row never exceeds the terminal width, so it can never soft-wrap", async () => {
  // A soft-wrapped row is the thing the removed anchor could not count. The composer keeps the row
  // inside the width instead, showing the tail — where the cursor is — with an ellipsis.
  const width = 40;
  const { terminal, screen } = displayTerminal({ columns: width });
  const pending = terminal.input.ask("> ");
  terminal.paste(MULTILINGUAL_DRAFT);
  await terminal.input.idle();
  const row = screen.cursorRow();
  assert.equal(displayWidth(row) <= width, true, `the row fits: ${displayWidth(row)} <= ${width}`);
  assert.equal(row.startsWith("> …"), true, `the trimmed head is marked: ${JSON.stringify(row)}`);
  assert.equal(row.includes("\n"), false, "and the row is one row, whatever the draft holds");
  terminal.enter();
  assert.equal(await pending, MULTILINGUAL_DRAFT, "while the draft itself is complete, exactly as pasted");
});

test("H4b: a narrow terminal gets the compact line count, and the draft before the notice", async () => {
  const { terminal, screen } = displayTerminal({ columns: 40 });
  const pending = terminal.input.ask("> ");
  terminal.paste("one\ntwo");
  await terminal.input.idle();
  // The full notice does not fit beside the draft, so the count is shortened: the suffix is dropped
  // before the draft is, because knowing what you typed matters more than knowing how many lines it is.
  assert.equal(screen.cursorRow(), "> one\u21b5two[2 lines]", "line breaks are shown, with the compact count");
  terminal.enter();
  assert.equal(await pending, "one\ntwo");
});

test("H5: a submitted multiline draft is echoed in full, as output below the composer's row", async () => {
  const { terminal, screen } = displayTerminal({ columns: 60 });
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

// ---------------------------------------------------------------- a real pseudo-terminal

/**
 * The same invariant, through a real PTY rather than a mocked key stream.
 *
 * Everything above drives `createPromptInput` in-process, which is exact about the composer and says
 * nothing about what a terminal does with the bytes: a real one echoes what it is given, and in raw
 * mode it does not. This test runs the composer on a genuine pseudo-terminal (`script`), feeds it a
 * paste and 400 Backspaces the way the operator did, interprets the captured output with the same
 * emulator, and asserts what a person would have seen.
 *
 * Skipped where `script` is unavailable; run on this machine as part of the M21 correctness pass.
 */
const TSX_IMPORT = import.meta.resolve("tsx");

test("PTY: a real terminal keeps its history when a pasted draft is deleted", { skip: process.platform === "darwin" ? false : "POSIX `script` only" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-pty-"));
  const driver = join(root, "driver.mts");
  writeFileSync(driver, `import { createPromptInput } from ${JSON.stringify(new URL("./prompt-input.ts", import.meta.url).pathname)};
const write = (text) => { process.stdout.write(text); };
// A watchdog, so a stuck PTY fails the test instead of hanging it: the suite runs many files at
// once, and a driver that never returns would otherwise sit until the spawn timeout.
setTimeout(() => { write("\\r\\nDRIVER-TIMEOUT\\r\\n"); process.exit(3); }, 20_000).unref();
write("history one: preflight ask=ready · write=ready\\r\\n");
write("history two: Task 11111111-2222-3333-4444-555555555555 · outcome=SUCCESS\\r\\n");
const input = createPromptInput({ input: process.stdin, write, terminal: true, columns: 60 });
const answer = await input.ask("> ");
input.close();
write("\\r\\nANSWER[" + JSON.stringify(answer) + "]\\r\\n");
process.exit(0);
`);
  const draft = "english line\nسطر عربي للاختبار\nemoji: 👩‍💻🚀\nanother long line that wraps in a normal terminal width";
  const keys = `${PASTE_START}${draft}${PASTE_END}${"\u007f".repeat(400)}typed request\r`;
  // The keys go through a file rather than a pipe: `script` needs a terminal on its own stdin, and
  // the harness gives it a socket, which it refuses ("tcgetattr/ioctl: Operation not supported").
  const keyFile = join(root, "keys.bin");
  writeFileSync(keyFile, keys);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    // Paced, like a person: the tty echoes input until the composer puts it in raw mode, and keys
    // written before the driver starts are echoed by the kernel rather than composed by BrainGate.
    // That echo is the terminal's, not this module's — but a test that cannot tell them apart would
    // report a bug that no operator could see.
    const result = spawnSync("/bin/sh", ["-c", `{ sleep 1.5; cat ${quote(keyFile)}; } | script -q /dev/null ${quote(process.execPath)} --import ${quote(TSX_IMPORT)} ${quote(driver)}`], {
      encoding: "buffer",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `driver exited cleanly: ${String(result.stderr).slice(0, 300)}`);
    const screen = new VirtualTerminal();
    screen.write(result.stdout.toString("utf8"));
    const shown = screen.screen();
    assert.equal(shown.includes("history one: preflight ask=ready · write=ready"), true, `the first line of history survived\n${shown.slice(-400)}`);
    assert.equal(shown.includes("history two: Task 11111111"), true, "and the second");
    assert.equal(shown.includes("سطر"), false, "no stale Arabic survived the deletions");
    assert.equal(shown.includes("👩"), false, "and no broken emoji");
    // The request typed after the deletions is what the composer submitted — through a real terminal.
    assert.equal(shown.includes(`ANSWER["typed request"]`), true, `the typed request was submitted\n${shown.slice(-300)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- intent is not a noun

/**
 * A question *about* a write is not a request to write.
 *
 * The acceptance prompt that found this asked Claude to report which worker wrote which marker and
 * what happened to a cancelled write attempt. It was classified as a WRITE, so the run took the write
 * path: a correctly cautious worker changed nothing, and a read-only question was recorded as a
 * failed write. `write` is a noun in that sentence — the name of the thing being asked about — and it
 * is the sharpest case of a word that is both, because it is the subject of half the questions an
 * operator asks about a session.
 */
test("W1: a question about a write is a read, and a request to write is still a write", () => {
  assert.equal(
    classifyRequestIntent("Read docs/notes.md from disk and quote both marker lines exactly. Then, from the BrainGate goal history you were given, state which provider and model wrote marker 1 and which wrote marker 2, and what happened to the Codex write attempt that was cancelled. Do not modify anything."),
    "read",
  );
  assert.equal(classifyRequestIntent("Which worker wrote marker 1?"), "read");
  assert.equal(classifyRequestIntent("Summarize the write attempts in this goal."), "read");
  assert.equal(classifyRequestIntent("What did the cancelled write attempt do?"), "read");
  // The imperative is unchanged: a request that leads with the verb is a request to write.
  assert.equal(classifyRequestIntent("Write the marker into docs/notes.md"), "write");
  assert.equal(classifyRequestIntent("Please write a summary to docs/summary.md"), "write");
  assert.equal(classifyRequestIntent("Then write the second marker line."), "write");
  assert.equal(classifyRequestIntent("Append exactly one inert marker comment line to docs/notes.md"), "write");
});
