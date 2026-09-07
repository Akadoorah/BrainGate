import test from "node:test";
import assert from "node:assert/strict";
import { checkDogfoodExportPath } from "./dogfood-export-path.js";

test("dogfood export defaults to the safe local .brain path", () => {
  assert.deepEqual(checkDogfoodExportPath(["dogfood", "export"]), { safe: true, reason: null });
});

test("dogfood export permits only direct files under .brain", () => {
  assert.equal(checkDogfoodExportPath(["dogfood", "export", "--output", ".brain/custom.jsonl"]).safe, true);
  assert.equal(checkDogfoodExportPath(["dogfood", "export", "--output", "outside.jsonl"]).safe, false);
  assert.equal(checkDogfoodExportPath(["dogfood", "export", "--output", ".brain/../outside.jsonl"]).safe, false);
  assert.equal(checkDogfoodExportPath(["dogfood", "export", "--output", ".brain/nested/out.jsonl"]).safe, false);
  assert.equal(checkDogfoodExportPath(["dogfood", "export", "--output", "/tmp/out.jsonl"]).safe, false);
});

test("dogfood export treats Windows separators as path separators", () => {
  assert.equal(checkDogfoodExportPath(["dogfood", "export", "--output", ".brain\\custom.jsonl"]).safe, true);
  assert.equal(checkDogfoodExportPath(["dogfood", "export", "--output", ".brain\\nested\\out.jsonl"]).safe, false);
});

test("unrelated CLI commands are untouched", () => {
  assert.deepEqual(checkDogfoodExportPath(["dogfood", "report"]), { safe: true, reason: null });
  assert.deepEqual(checkDogfoodExportPath(["discover", "--json"]), { safe: true, reason: null });
});
