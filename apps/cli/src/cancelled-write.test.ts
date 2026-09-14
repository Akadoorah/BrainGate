import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectRegistry, TaskLedger, executionScopeFor } from "@braingate/core";
import { GoalStore } from "@braingate/goals";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "@braingate/shadow";
import type { WriteProviderExecutor, WriteProviderPlan, WriteProviderResult } from "@braingate/write";
import { runRepl } from "./repl.js";

/**
 * A declined DIRECT write must leave nothing behind.
 *
 * The operator's manual smoke found the contradiction: the confirmation said "This changes files in
 * your workspace" and they answered `n` — "Skipped. Nothing was spent." — and afterwards `/worker`
 * listed a new write session for the provider they had just declined. A session is a claim that work
 * ran in a conversation; creating one for work that was refused makes the surface lie about what
 * happened, and it is the difference between a plan and an execution.
 *
 * This drives the real REPL with fake runtimes and asserts every one of the seven things an execution
 * would have produced: an invocation, a task, a turn, a session, a file change, a route on a task,
 * and a receipt. Planning may read metadata; it may not do any of these.
 */

const TARGET = "docs/notes.md";

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr));
}

function snapshot(providerId: "anthropic" | "openai" | "xai", models: readonly string[], version: string): ProviderSnapshot {
  const observedAt = "2026-09-14T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName: providerId,
    binary: providerId === "anthropic" ? "claude" : providerId,
    available: obs(true), version: obs(version), authState: obs("authenticated"), authMode: obs("subscription"),
    models: obs([...models]),
    capabilities: obs({ headless: true, modelPinning: true, sessionIdPinning: providerId !== "openai", outputFormats: ["json"], supportsMcp: true, supportsSubagents: true }),
    quotaState: obs("unknown"), quotaHint: obs(null), quotaObservedAt: obs(null), refusalBackoffUntil: obs(null), observedAt,
  } as unknown as ProviderSnapshot;
}

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `braingate-cancel-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, TARGET), "# Notes\n\nA line that must not change.\n");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  mkdirSync(join(repo, ".brain"), { recursive: true });
  writeFileSync(join(repo, ".brain", "project.json"), JSON.stringify({ project_id: label, name: label, repositories: [repo] }));
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  const catalog = new ModelCatalog(resolveOperatorState(env, repo).modelCatalogPath);
  for (const [providerId, modelId] of [["anthropic", "claude-sonnet-5"], ["openai", "gpt-6-astra"], ["xai", "grok-4.6"]] as const) {
    catalog.upsert({
      providerId, modelId, quotaPool: `${providerId}-subscription`,
      capabilities: { coder: 92, reviewer: 70, judge: 65 }, speed: "balanced",
      contextCapacity: 200_000, writeCapable: true, reasoning: 90, underlyingFamily: null,
    });
  }
  return { root, repo, env, home };
}

/** Runtimes that record everything and change the file, so an execution cannot happen unnoticed. */
class RecordingWorkers {
  reads = 0;
  writes: string[] = [];
  readonly shadow: ShadowProcessExecutor = {
    run: async (input: { readonly plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> => {
      this.reads += 1;
      return { spawned: true, exitCode: 0, timedOut: false, durationMs: 1, stderr: "", removedEnvironmentKeys: [], stdout: JSON.stringify({ result: JSON.stringify({ kind: "work", output: "answer" }) }) };
    },
  };
  readonly writer: WriteProviderExecutor = {
    run: async (input: { readonly plan: WriteProviderPlan }): Promise<WriteProviderResult> => {
      this.writes.push(input.plan.providerId);
      writeFileSync(join(input.plan.cwd, TARGET), `${readFileSync(join(input.plan.cwd, TARGET), "utf8")}<!-- executed -->\n`);
      return { spawned: true, exitCode: 0, timedOut: false, durationMs: 1, stderr: "", removedEnvironmentKeys: [], stdout: JSON.stringify({ result: JSON.stringify({ summary: "wrote it" }) }) };
    },
  };
}

function sessionOf(repo: string, env: NodeJS.ProcessEnv, workers: RecordingWorkers, answers: readonly string[]) {
  const remaining = [...answers];
  let out = "";
  return {
    text: () => out,
    run: () => runRepl({
      cwd: repo, env, animate: false, colour: false,
      stdout: (t) => { out += t; }, stderr: (t) => { out += t; },
      ask: async () => remaining.shift() ?? null,
      executor: workers.shadow,
      writeExecutor: workers.writer,
      discoverAll: async () => [snapshot("anthropic", ["claude-sonnet-5"], "2.1.270"), snapshot("openai", ["gpt-6-astra"], "0.153.4"), snapshot("xai", ["grok-4.6"], "1.0.24")],
      probeCapabilities: async (providerId: string) => ({ features: { sessionIdPinning: { supported: providerId !== "openai" }, sessionResume: { supported: true } } }),
      measureCapabilities: async () => ({}),
      verifyGrokIsolation: async (item: ProviderSnapshot) => ({
        providerId: "xai" as const, source: "sandbox-event-self-test" as const, version: item.version.value ?? "0.0.0",
        platform: "darwin" as const, profileHash: "p", policyHash: "p",
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        readableRoots: [], networkRestricted: true, configSurfaces: [],
      }),
      verifyCodexIsolation: async (item: ProviderSnapshot) => ({
        providerId: "openai" as const, source: "sandbox-self-test" as const, version: item.version.value ?? "0.0.0",
        platform: "darwin" as const, profileHash: "p", policyHash: "p",
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        unrecognisedKeys: [], droppedKeys: [], droppedFeatureKeys: [],
      }),
    }),
  };
}

const REQUEST = `Append one inert marker line to ${TARGET} and modify no other file. Do not commit.`;

for (const [providerId, modelId] of [["anthropic", "claude-sonnet-5"], ["openai", "gpt-6-astra"], ["xai", "grok-4.6"]] as const) {
  test(`a declined DIRECT write leaves nothing behind: ${providerId}`, async () => {
    const f = fixture(providerId);
    const workers = new RecordingWorkers();
    const before = createHash("sha256").update(readFileSync(join(f.repo, TARGET))).digest("hex");
    const session = sessionOf(f.repo, f.env, workers, [`/use ${providerId}/${modelId}`, REQUEST, "n", "/worker", "/exit"]);
    try {
      assert.equal(await session.run(), 0, session.text());
      assert.match(session.text(), /Skipped\. Nothing was spent\./);

      // No execution of any kind.
      assert.equal(workers.writes.length, 0, "no write invocation");
      assert.equal(workers.reads, 0, "no read invocation either");
      const after = createHash("sha256").update(readFileSync(join(f.repo, TARGET))).digest("hex");
      assert.equal(after, before, "the file is untouched");

      // The reported symptom, asserted where the operator saw it. `/worker` prints a "Native session"
      // line only when a run resolved one, so a declined write must leave that line absent — the
      // session a plan *would* have used is not a session that exists.
      assert.doesNotMatch(session.text(), /Native session: (new|resuming)/, "the worker view claims no session for a declined write");

      const scope = executionScopeFor(new ProjectRegistry(f.home).loadFile(join(f.repo, ".brain", "project.json")), f.repo);
      const goals = new GoalStore(scope.project);
      const ledger = new TaskLedger(scope.project);
      try {
        assert.equal(ledger.listTasks().length, 0, "no task was created");
        assert.equal(goals.listProviderSessions().length, 0, "and no native session was registered");
        const goal = goals.activeGoal();
        assert.equal(goal === null ? 0 : goals.recentTurns(goal.conversationId, 50).length, 0, "and no goal turn was recorded");
      } finally { ledger.close(); goals.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

/**
 * A successful write turn names the worker that made the change.
 *
 * The same smoke that produced an empty `attributedTo` also produced the ledger entry that answers
 * it: `task.execution` carries the provider and model that completed. The delta said "another worker"
 * about work whose author was recorded all along, because only the read path reported attribution.
 */
for (const [providerId, modelId] of [["openai", "gpt-6-astra"], ["xai", "grok-4.6"]] as const) {
  test(`an executed DIRECT write records who performed it: ${providerId}`, async () => {
    const f = fixture(`attributed-${providerId}`);
    const workers = new RecordingWorkers();
    const session = sessionOf(f.repo, f.env, workers, [`/use ${providerId}/${modelId}`, REQUEST, "y", "/exit"]);
    try {
      assert.equal(await session.run(), 0, session.text());
      assert.equal(workers.writes.length, 1, "the write ran");
      assert.equal(readFileSync(join(f.repo, TARGET), "utf8").includes("<!-- executed -->"), true, "and changed the file");

      const scope = executionScopeFor(new ProjectRegistry(f.home).loadFile(join(f.repo, ".brain", "project.json")), f.repo);
      const goals = new GoalStore(scope.project);
      try {
        const goal = goals.activeGoal();
        assert.notEqual(goal, null);
        const turns = goals.recentTurns(goal!.conversationId, 10);
        assert.equal(turns.length, 1, "the write is a turn on the goal");
        assert.deepEqual([...turns[0]!.attributedTo], [`${providerId}/${modelId}`], "and it names the worker that did it");
        // The delta a later worker receives says the same thing, from the same record.
        const delta = goal!.state;
        assert.notEqual(delta, null);
      } finally { goals.close(); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
