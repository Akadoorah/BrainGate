import test from "node:test";
import assert from "node:assert/strict";
import { COLOURED_PROGRESS, PLAIN_PROGRESS, progressFrame, startProgress } from "./progress.js";

/** A controllable clock and timer, so the tests never wait on a real one. */
function harness() {
  let written = "";
  let clock = 0;
  const ticks: (() => void)[] = [];
  return {
    text: () => written,
    advance: (ms: number) => { clock += ms; },
    fire: () => { for (const tick of [...ticks]) tick(); },
    options: {
      write: (text: string) => { written += text; },
      now: () => clock,
      setInterval: (fn: () => void) => { ticks.push(fn); return { unref: () => { /* test timer */ } }; },
      clearInterval: () => { ticks.length = 0; },
    },
  };
}

test("a frame shows the gate, the moving mark, and elapsed whole seconds", () => {
  const frame = progressFrame("working", 2, 7_400);
  assert.match(frame, /▌/);
  assert.match(frame, /◈/);
  assert.match(frame, /▸/);
  assert.match(frame, /working · 7s/);
});

test("the mark moves and the gate never does", () => {
  const positions = [0, 1, 2, 3].map((tick) => progressFrame("working", tick, 0).indexOf("▸"));
  assert.equal(new Set(positions).size, positions.length, "the mark must move every tick");
  const gates = [0, 1, 2, 3].map((tick) => progressFrame("working", tick, 0).indexOf("◈"));
  assert.equal(new Set(gates).size, 1, "the gate must stay put");
});

test("stopping erases the indicator, leaving no trail", () => {
  const h = harness();
  const progress = startProgress({ ...h.options, label: "working" });
  h.advance(1_000); h.fire();
  h.advance(1_000); h.fire();
  progress.stop();
  // Whatever was drawn must be erased: the last thing written is a clear, not a frame.
  assert.match(h.text(), /\r\[2K$/);
});

test("stop is idempotent, so the first byte of output can call it blindly", () => {
  const h = harness();
  const progress = startProgress({ ...h.options, label: "working" });
  progress.stop();
  const afterFirst = h.text();
  progress.stop();
  progress.stop();
  assert.equal(h.text(), afterFirst, "stopping twice must not write again");
});

test("a stopped indicator does not draw again on a later tick", () => {
  const h = harness();
  const progress = startProgress({ ...h.options, label: "working" });
  progress.stop();
  const afterStop = h.text();
  h.advance(5_000);
  h.fire();
  assert.equal(h.text(), afterStop, "a timer that outlived stop must draw nothing");
});

test("nothing is drawn where the line cannot be redrawn", () => {
  const h = harness();
  // A pipe, CI, or a dumb terminal: a spinner that cannot erase itself would leave every frame
  // in the log.
  const progress = startProgress({ ...h.options, label: "working", animate: false });
  h.advance(3_000); h.fire();
  progress.stop();
  assert.equal(h.text(), "");
});

test("colour decorates without changing the picture", () => {
  const plain = progressFrame("working", 1, 1_000, PLAIN_PROGRESS);
  const coloured = progressFrame("working", 1, 1_000, COLOURED_PROGRESS);
  assert.doesNotMatch(plain, /\[/);
  // eslint-disable-next-line no-control-regex
  assert.equal(coloured.replace(/\[[0-9;]*m/g, ""), plain);
});
