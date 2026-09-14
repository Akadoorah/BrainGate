import test from "node:test";
import assert from "node:assert/strict";
import { COLOURED, PLAIN, bannerFrames, bannerStill, renderBanner } from "./banner.js";

test("every frame is a complete picture, never a half-drawn one", () => {
  const frames = bannerFrames(PLAIN);
  assert.ok(frames.length > 1);
  for (const frame of frames) {
    for (const line of frame.split("\n")) {
      // The rail is the banner's identity; a frame missing it would read as a glitch.
      assert.match(line, /^ {2}▌ {2}\S/, `frame line is malformed: ${JSON.stringify(line)}`);
    }
  }
});

test("the wordmark reveals, the track sweeps once, and the tagline settles the picture", () => {
  const frames = bannerFrames(PLAIN);
  assert.match(frames[0]!, /^ {2}▌ {2}B$/, "the first frame should show one letter");
  const still = bannerStill(PLAIN);
  assert.match(still, /B R A I N G A T E/);
  assert.match(still, /one goal, many native CLIs/);
  // The banner must not claim what is not built: council orchestration is a later milestone, and a
  // tagline promising it would be the first thing a new user found to be untrue.
  assert.doesNotMatch(still, /council|every provider|all providers/i);

  // The travelling mark occupies a different cell in each sweep frame, and the gate is always
  // drawn, so the picture reads as one request passing through it.
  const sweeps = frames.filter((frame) => frame.includes("▸"));
  const positions = sweeps.map((frame) => frame.split("\n")[1]!.indexOf("▸"));
  assert.ok(sweeps.length > 1, "there should be more than one sweep frame");
  assert.equal(new Set(positions).size, positions.length, "the mark must move every frame");
  assert.ok(sweeps.every((frame) => frame.includes("◈")), "the gate must be drawn throughout");
});

test("still mode draws the finished picture once and animates nothing", async () => {
  let written = "";
  let slept = 0;
  await renderBanner({ write: (t) => { written += t; }, still: true, sleep: async () => { slept += 1; } });
  assert.equal(slept, 0, "still mode must not wait");
  // Strip only the surrounding blank lines: the banner's own leading indentation is part of it.
  assert.equal(written.replace(/^\n+|\n+$/g, ""), bannerStill(PLAIN), "still mode must draw exactly the final frame");
});

test("animated mode redraws in place instead of accumulating frames", async () => {
  let written = "";
  await renderBanner({ write: (t) => { written += t; }, sleep: async () => { /* instant */ } });
  const frames = bannerFrames(PLAIN);
  // One cursor-up sequence per frame after the first: without them the frames would stack.
  const redraws = written.match(/\[\d+A/g) ?? [];
  assert.equal(redraws.length, frames.length - 1);
  assert.ok(written.includes(bannerStill(PLAIN)), "the finished picture must be what remains");
});

test("colour is applied when asked for and absent otherwise", () => {
  assert.doesNotMatch(bannerStill(PLAIN), /\[/, "the plain style must emit no escape codes");
  assert.match(bannerStill(COLOURED), /\[/);
  // The same picture either way: colour decorates, it does not carry meaning.
  // eslint-disable-next-line no-control-regex
  assert.equal(bannerStill(COLOURED).replace(/\[[0-9;]*m/g, ""), bannerStill(PLAIN));
});
