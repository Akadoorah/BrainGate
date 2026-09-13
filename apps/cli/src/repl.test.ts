import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { initializeDogfoodProject } from "@braingate/dogfood";
import { ProjectRegistry } from "@braingate/core";
import { ProjectMemory } from "@braingate/memory";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import { activityLabel, grantLines, looksLikeWriteRequest, runRepl, withoutStreamedAnswer } from "./repl.js";

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

/**
 * A state directory of this session's own, with a catalogue in it.
 *
 * Without this the session resolves `~/.braingate` — the operator's real catalogue, acceptances and
 * quota history — and writes a project's stores into it. Two tests in this file were failing on
 * exactly that: the write hit a state directory the sandbox would not let them open, and the
 * failure arrived as `CLI_UNEXPECTED` with the details suppressed, so the suite said "environment"
 * and nothing more. A test that needs the operator's home to be writable is testing the machine.
 */
function operatorEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "braingate-repl-home-"));
  const env = { BRAINGATE_HOME: home };
  const catalog = new ModelCatalog(resolveOperatorState(env, home).modelCatalogPath);
  for (const [providerId, modelId, coder, speed] of [
    ["anthropic", "claude-sonnet-5", 95, "balanced"],
    ["anthropic", "claude-haiku-4-5", 85, "fast"],
  ] as const) {
    catalog.upsert({
      providerId, modelId, quotaPool: `${providerId}-subscription`,
      capabilities: { coder, reviewer: 70, judge: 65 }, speed,
      contextCapacity: 200_000, writeCapable: true, reasoning: coder, underlyingFamily: null,
    });
  }
  return env;
}

/**
 * One provider, as a snapshot the session can route against without asking the machine.
 *
 * The session used to discover providers for real, which made these tests depend on the operator's
 * own Claude and Codex logins and take seconds each: with a redirected HOME the CLI reports itself
 * logged out and two of them failed, and with the real HOME they were passing by accident. A
 * planning test is about planning, so the discovery it needs is supplied.
 */
function snapshot(providerId: "anthropic" | "openai", models: readonly string[]): ProviderSnapshot {
  const observedAt = "2026-09-13T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName: providerId === "anthropic" ? "Claude Code" : "Codex CLI",
    binary: providerId === "anthropic" ? "claude" : "codex",
    available: obs(true),
    version: obs("2.1.269"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: obs([...models]),
    capabilities: obs({ headless: true, modelPinning: true, sessionIdPinning: true, outputFormats: ["json"], supportsMcp: true, supportsSubagents: true }),
    quotaState: obs("unknown"),
    quotaHint: obs(null),
    quotaObservedAt: obs(null),
    refusalBackoffUntil: obs(null),
    observedAt,
  } as unknown as ProviderSnapshot;
}

/** Drives a session from a fixed script of answers, capturing everything written. */
function session(cwd: string, answers: readonly string[]) {
  const remaining = [...answers];
  const asked: string[] = [];
  // How much had been printed when each question was put. The gate is an ordering, and a test that
  // only checks a question was asked cannot tell that the plan it refers to came before it.
  const askedAt: number[] = [];
  let out = ""; let err = "";
  return {
    asked,
    askedAt,
    text: () => `${out}${err}`,
    run: () => runRepl({
      cwd,
      env: operatorEnv(),
      animate: false,
      colour: false,
      stdout: (t) => { out += t; },
      stderr: (t) => { err += t; },
      // A null answer is end of input, which ends the session.
      ask: async (question) => { asked.push(question); askedAt.push(out.length + err.length); return remaining.shift() ?? null; },
      discoverAll: async () => [snapshot("anthropic", ["claude-sonnet-5", "claude-haiku-4-5"]), snapshot("openai", ["gpt-6-astra"])],
      probeCapabilities: async () => ({ features: { sessionIdPinning: { supported: true } } }),
      measureCapabilities: async () => ({}),
      verifyCodexIsolation: async (item: ProviderSnapshot) => ({
        providerId: "openai" as const, source: "sandbox-self-test" as const,
        version: item.version.value ?? "0.0.0", platform: "darwin" as const,
        profileHash: "test-profile", policyHash: "test-policy",
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        unrecognisedKeys: [], droppedKeys: [], droppedFeatureKeys: [],
      }),
      verifyGrokIsolation: async (item: ProviderSnapshot) => ({
        providerId: "xai" as const, source: "sandbox-event-self-test" as const,
        version: item.version.value ?? "0.0.0", platform: "darwin" as const,
        profileHash: "test-profile", policyHash: "test-policy",
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        readableRoots: [], networkRestricted: true, configSurfaces: [],
      }),
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
  // DIRECT is the default policy (ADR 0017), so the honest line names the workspace, not a
  // worktree. The plan must also be printed before the question that lets it run: the operator
  // cannot decline something they were never shown.
  assert.match(s.text(), /write · direct · in your workspace/);
  assert.ok(s.asked.some((q) => /changes files in your workspace, and nothing is committed/.test(q)), "the write confirmation must say where the change lands");
  const gate = s.asked.findIndex((q) => /Run it\?/.test(q));
  assert.ok(gate >= 0, "the run must be confirmed before it happens");
  const planned = s.text().indexOf("write · direct · in your workspace");
  assert.ok(planned >= 0 && planned < (s.askedAt[gate] ?? 0), "the plan was not shown before the confirmation");
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

test("the confirmation shows what each role may do, not only which model was chosen", () => {
  const planned = [
    "T4/medium · planner=anthropic/claude-fable-5-1 · reviewer=openai/gpt-6-astra",
    "  planner: read, subagents · refused web",
    "  reviewer: read · refused subagents",
    "Zero provider model calls executed.",
  ].join("\n");
  assert.deepEqual([...grantLines(planned)], [
    "planner: read, subagents · refused web",
    "reviewer: read · refused subagents",
  ]);
  assert.deepEqual([...grantLines("T0/low · primary=anthropic/claude-haiku-4-5")], []);
});

test("the indicator names the role, the model and the pool being spent", () => {
  assert.equal(
    activityLabel({ role: "planner", model: "grok-4.6", quotaPool: "grok-subscription" }),
    "planning · grok-4.6 · grok-subscription",
  );
  assert.equal(
    activityLabel({ role: "reviewer", model: "gpt-6-astra", quotaPool: "chatgpt-subscription" }),
    "reviewing · gpt-6-astra · chatgpt-subscription",
  );
  // A role with no better verb still says which model is spending the time.
  assert.match(activityLabel({ role: "primary", model: "claude-sonnet-5", quotaPool: "claude-subscription" }), /^working · claude-sonnet-5/);
});

test("an answer that was streamed live is not printed a second time", () => {
  const finished = "The service reports failures through a shared handler.\n\nTask 8fbc9645 · observed=1 · outcome=approved";
  assert.equal(withoutStreamedAnswer(finished), "\nTask 8fbc9645 · observed=1 · outcome=approved");
  // Nothing recognisable to keep is better than repeating the whole answer.
  assert.equal(withoutStreamedAnswer("just an answer with no receipt"), "");
});

// ---------------------------------------------------------------- output is printed once

/** What a run prints when the answer streamed live: the receipt, and the answer only once. */
test("R: a streamed answer is not printed a second time by the final block", () => {
  const block = "The theme is read from config.yml.\n\nTask 4f2c1a77-1111-4111-8111-111111111111 · observed=1 · outcome=SUCCESS\n";
  const kept = withoutStreamedAnswer(block);
  assert.doesNotMatch(kept, /The theme is read/, "the streamed answer is not repeated");
  assert.match(kept, /Task 4f2c1a77/, "and the receipt survives");
  // Nothing to keep when the run printed no receipt at all: printing the answer again would be the
  // duplication this exists to prevent.
  assert.equal(withoutStreamedAnswer("The theme is read from config.yml.\n"), "");
});

test("S: text a provider repeated itself is stored and printed once, not duplicated again", () => {
  // The provider's own output is the provider's; BrainGate does not edit it. What it must not do is
  // add a second copy on the way out. The receipt boundary is the whole mechanism.
  const providerText = "The flag is unused.\nThe flag is unused.\n";
  const block = `${providerText}\nTask 4f2c1a77-1111-4111-8111-111111111111 · observed=1 · outcome=SUCCESS\n`;
  const kept = withoutStreamedAnswer(block);
  assert.equal(kept.match(/The flag is unused\./g), null, "the answer stays out of the receipt block");
  assert.equal(providerText.match(/The flag is unused\./g)?.length, 2, "and the provider's text is preserved as it was");
});
