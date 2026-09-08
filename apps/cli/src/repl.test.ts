import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { initializeDogfoodProject } from "@braingate/dogfood";
import { ProjectRegistry } from "@braingate/core";
import { ProjectMemory } from "@braingate/memory";
import { looksLikeWriteRequest, runRepl } from "./repl.js";

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}

function project(): string {
  // returns the repo path; the registry lives beside it

  const root = mkdtempSync(join(tmpdir(), "braingate-repl-"));
  const repo = join(root, "demo"); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "config.yml"), "theme: dark\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "initial"]);
  initializeDogfoodProject({ cwd: repo, projectId: "demo", name: "Demo" });
  return repo;
}

/** Drives a session from a fixed script of answers, capturing everything written. */
function session(cwd: string, answers: readonly string[]) {
  const remaining = [...answers];
  const asked: string[] = [];
  let out = ""; let err = "";
  return {
    asked,
    text: () => `${out}${err}`,
    run: () => runRepl({
      cwd,
      stdout: (t) => { out += t; },
      stderr: (t) => { err += t; },
      // A null answer is end of input, which ends the session.
      ask: async (question) => { asked.push(question); return remaining.shift() ?? null; },
    }),
  };
}

test("a question is planned and skipped unless confirmed, so typing never spends on its own", async () => {
  const repo = project();
  // Decline the plan, then end the session.
  const s = session(repo, ["where is the theme configuration defined?", "n"]);
  assert.equal(await s.run(), 0);
  assert.match(s.text(), /read-only/);
  assert.match(s.text(), /Skipped\. Nothing was spent\./);
  // The confirmation is the gate: it must have been asked before anything could run.
  assert.ok(s.asked.some((q) => /Run it\?/.test(q)), "no confirmation was requested");
});

test("an instruction is recognised as a write and says so before asking", async () => {
  const repo = project();
  const s = session(repo, ["change the empty-state label to Nothing yet", "n"]);
  assert.equal(await s.run(), 0);
  assert.match(s.text(), /write · isolated worktree/);
  assert.ok(s.asked.some((q) => /never your checkout/.test(q)), "the write confirmation must say where the change lands");
});

test("write intent is detected from an instruction, not from a question", () => {
  assert.equal(looksLikeWriteRequest("change the label to X"), true);
  assert.equal(looksLikeWriteRequest("Rename the helper"), true);
  assert.equal(looksLikeWriteRequest("fix the typo in the README"), true);
  assert.equal(looksLikeWriteRequest("where is the theme configuration defined?"), false);
  assert.equal(looksLikeWriteRequest("which modules send email?"), false);
  assert.equal(looksLikeWriteRequest("how does the router score models?"), false);
});

test("slash commands work and /exit ends the session", async () => {
  const repo = project();
  const s = session(repo, ["/help", "/exit"]);
  assert.equal(await s.run(), 0);
  assert.match(s.text(), /\/feedback <task-id>/);
});

test("an unregistered directory is offered registration, not turned away", async () => {
  const empty = mkdtempSync(join(tmpdir(), "braingate-repl-empty-"));
  // Declining leaves nothing registered, but the offer is the point: arriving somewhere new is
  // the ordinary first run, and the banner has already said what this is.
  const s = session(empty, ["n"]);
  assert.notEqual(await s.run(), 0);
  assert.ok(s.asked.some((q) => /Register this repository now/.test(q)), "registration was never offered");
  assert.match(s.text(), /isolation boundary/);
  assert.match(s.text(), /braingate init/);
});

test("accepting the offer registers the project and continues into the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-repl-adopt-"));
  const repo = join(root, "my-service"); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "x.txt"), "x\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "initial"]);

  // Accept, then take both suggested identity answers, then leave.
  const s = session(repo, ["y", "", "", "/exit"]);
  assert.equal(await s.run(), 0);
  assert.equal(JSON.parse(readFileSync(join(repo, ".brain", "project.json"), "utf8")).project_id, "my-service");
  // The session must actually start, not merely register and stop.
  assert.match(s.text(), /Type a request, or \/help/);
});

test("a session turn never becomes project memory", async () => {
  const repo = project();
  // Two exchanges, both declined so nothing is spent; the thread is still recorded in-process.
  const s = session(repo, ["which modules send email?", "n", "and the other one?", "n", "/exit"]);
  assert.equal(await s.run(), 0);

  // Project memory is durable and evidence-gated. A session turn is neither, and must not have
  // acquired the standing of a promoted record by passing through the session.
  const registry = new ProjectRegistry(join(repo, "..", "registry"));
  const registered = registry.loadFile(join(repo, ".brain", "project.json"));
  const memory = new ProjectMemory(registered);
  try {
    assert.equal(memory.listEffective(50).length, 0, "the session wrote to project memory");
  } finally { memory.close(); }
});

test("/forget clears the thread without touching project memory", async () => {
  const repo = project();
  const s = session(repo, ["/forget", "/exit"]);
  assert.equal(await s.run(), 0);
  assert.match(s.text(), /Project memory is untouched/);
});

test("a subdirectory of a registered repository is not offered registration again", async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-repl-nested-"));
  const repo = join(root, "monorepo"); mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "README.md"), "root\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "initial"]);
  initializeDogfoodProject({ cwd: repo, projectId: "monorepo", name: "Monorepo" });

  const nested = join(repo, "apps", "flutter_migration");
  mkdirSync(nested, { recursive: true });

  // init writes the manifest at the repository root. Offering to register from a subdirectory
  // produced a second identity and then PROJECT_INIT_CONFLICT, which is what this pins against.
  const s = session(nested, ["/exit"]);
  assert.equal(await s.run(), 0);
  assert.ok(!s.asked.some((q) => /Register this repository now/.test(q)), "registration was offered inside an already-registered repository");
  assert.match(s.text(), /Type a request, or \/help/);
});
