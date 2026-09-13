import test from "node:test";
import assert from "node:assert/strict";
import { createPromptInput, PASTE_END, PASTE_START, type PromptInput } from "./prompt-input.js";

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

  constructor(options: { readonly terminal?: boolean } = {}) {
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
      write: (text: string) => { this.#written.push(text); },
      terminal: options.terminal ?? true,
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
  assert.match(terminal.written(), /2 lines pending/, "and the operator is told it is pending");

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
