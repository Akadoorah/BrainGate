import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTIGRAVITY_READ_RULE, ANTIGRAVITY_SHELL_RULE, antigravitySettingsPath, readAntigravityHeadlessPermissions } from "./antigravity-permissions.js";

/**
 * Antigravity's DIRECT gate is a reading of the operator's own settings, so the reading has to be
 * exact: a rule that is not there must not be invented, a rule that is there must be seen, and a
 * rule scoped to some other directory must not count for this workspace.
 */

test("no settings file means nothing is allowed, and the path says where a rule would go", () => {
  const home = mkdtempSync(join(tmpdir(), "braingate-agy-"));
  try {
    const read = readAntigravityHeadlessPermissions({ env: { HOME: home } });
    assert.equal(read.present, false);
    assert.equal(read.reads, false);
    assert.equal(read.shell, false);
    assert.deepEqual([...read.rules], []);
    assert.equal(read.path, antigravitySettingsPath({ HOME: home }));
    assert.equal(read.path, join(home, ".gemini", "antigravity-cli", "settings.json"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the two rules the CLI names open reads and the shell, and nothing else does", () => {
  const home = mkdtempSync(join(tmpdir(), "braingate-agy-"));
  try {
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    const path = join(home, ".gemini", "antigravity-cli", "settings.json");
    writeFileSync(path, JSON.stringify({ trustedWorkspaces: [home], permissions: { allow: [ANTIGRAVITY_READ_RULE] } }));
    const readsOnly = readAntigravityHeadlessPermissions({ env: { HOME: home } });
    assert.equal(readsOnly.present, true);
    assert.equal(readsOnly.reads, true, "read_file(*) allows headless reads");
    assert.equal(readsOnly.shell, false, "and says nothing about the shell");

    writeFileSync(path, JSON.stringify({ permissions: { allow: [ANTIGRAVITY_READ_RULE, ANTIGRAVITY_SHELL_RULE, "execute_url(*)"] } }));
    const both = readAntigravityHeadlessPermissions({ env: { HOME: home } });
    assert.equal(both.reads, true);
    assert.equal(both.shell, true, "command(*) allows the shell");
    assert.deepEqual([...both.rules], [ANTIGRAVITY_READ_RULE, ANTIGRAVITY_SHELL_RULE, "execute_url(*)"], "every rule is kept for the record");

    // A rule for a different tool, a malformed rule, or an empty list grants nothing.
    writeFileSync(path, JSON.stringify({ permissions: { allow: ["execute_url(*)", "read_file", 42, "read_file()"] } }));
    const none = readAntigravityHeadlessPermissions({ env: { HOME: home } });
    assert.equal(none.present, true);
    assert.equal(none.reads, false);
    assert.equal(none.shell, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a path-scoped rule counts for a workspace under it and not for one beside it", () => {
  const settings = JSON.stringify({ permissions: { allow: ["read_file(/srv/projects)", "command(/srv/projects/api/)"] } });
  const inside = readAntigravityHeadlessPermissions({ settingsText: settings, workspace: "/srv/projects/api" });
  assert.equal(inside.reads, true);
  assert.equal(inside.shell, true, "a trailing slash on the rule still matches the directory itself");
  const beside = readAntigravityHeadlessPermissions({ settingsText: settings, workspace: "/srv/projects-archive" });
  assert.equal(beside.reads, false, "a sibling whose name merely starts the same is not under the rule");
  assert.equal(beside.shell, false);
  const unknown = readAntigravityHeadlessPermissions({ settingsText: settings });
  assert.equal(unknown.reads, false, "with no workspace to compare, a scoped rule is not a general grant");
});

test("unreadable settings are reported as absent rather than as a grant", () => {
  const broken = readAntigravityHeadlessPermissions({ settingsText: "{ not json" });
  assert.equal(broken.present, false);
  assert.equal(broken.reads, false);
  const wrongShape = readAntigravityHeadlessPermissions({ settingsText: JSON.stringify({ permissions: "read_file(*)" }) });
  assert.equal(wrongShape.present, true);
  assert.equal(wrongShape.reads, false);
});

test("an environment that names no home reads nothing, so a hermetic caller never sees the operator's rules", () => {
  const read = readAntigravityHeadlessPermissions({ env: {} });
  assert.equal(read.present, false);
  assert.equal(read.reads, false);
  assert.equal(read.shell, false);
});
