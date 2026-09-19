import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ProjectRegistry, TaskLedger, executionScopeFor } from "@braingate/core";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import { codexIsolationProfileHash, type ShadowInvocationPlan, type ShadowProcessExecutor, type ShadowProcessResult } from "@braingate/shadow";
import type { WriteProviderExecutor, WriteProviderPlan, WriteProviderResult } from "@braingate/write";
import { runRepl } from "./repl.js";

/**
 * A big write, from the operator's side of the terminal (ADR 0021).
 *
 * The session's policy here is the default, DIRECT, and the request is a T3 change to
 * authentication. What the operator must see is not a refusal and not a quiet edit of their
 * checkout: a plan that says it has been moved to a worktree and why, a reviewer from a different
 * subscription than the worker, a worktree under BrainGate's own storage, their own files exactly
 * as they left them, and a merge that never happened. And when their checkout is dirty — the
 * ordinary state of someone mid-task — one message and nothing spent.
 *
 * Every runtime below is a fake that answers in its CLI's envelope, so no subscription is spent.
 */

const BIG_TASK = "Change the authentication acceptance logic in auth/login.ts.";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
  return String(result.stdout ?? "").trim();
}

function snapshot(providerId: "anthropic" | "openai"): ProviderSnapshot {
  const observedAt = "2026-09-19T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName: providerId === "anthropic" ? "Claude Code" : "Codex CLI",
    binary: providerId === "anthropic" ? "claude" : "codex",
    available: obs(true),
    version: obs(providerId === "anthropic" ? "2.1.278" : "0.153.4"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: obs(providerId === "anthropic" ? ["claude-sonnet-5"] : ["gpt-6-astra"]),
    capabilities: obs({ headless: true, modelPinning: true, sessionIdPinning: providerId === "anthropic", outputFormats: ["json"], supportsMcp: true, supportsSubagents: true }),
    quotaState: obs("unknown"),
    quotaHint: obs(null),
    quotaObservedAt: obs(null),
    refusalBackoffUntil: obs(null),
    observedAt,
  } as unknown as ProviderSnapshot;
}

/** A workspace with an auth file worth protecting, one commit, and two scored subscriptions. */
function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `braingate-big-${label}-`));
  const repo = join(root, "repo");
  const login = join(repo, "auth", "login.ts");
  mkdirSync(join(repo, "auth"), { recursive: true });
  writeFileSync(login, "export function accept(): boolean { return false; }\n");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  mkdirSync(join(repo, ".brain"), { recursive: true });
  writeFileSync(join(repo, ".brain", "project.json"), JSON.stringify({ project_id: label, name: label, repositories: [repo] }));
  writeFileSync(join(repo, ".git", "info", "exclude"), ".brain/\n");
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  const catalog = new ModelCatalog(resolveOperatorState(env, repo).modelCatalogPath);
  catalog.upsert({
    providerId: "anthropic", modelId: "claude-sonnet-5", quotaPool: "claude-subscription",
    capabilities: { coder: 95, reviewer: 70, judge: 70 }, speed: "balanced",
    contextCapacity: 200_000, writeCapable: true, reasoning: 92, underlyingFamily: null,
  });
  // A reviewer on the other subscription, scored for review and not for writing: the independent
  // reader a big write needs, and never a candidate to be the worker it is reviewing.
  catalog.upsert({
    providerId: "openai", modelId: "gpt-6-astra", quotaPool: "chatgpt-subscription",
    capabilities: { coder: 60, reviewer: 94, judge: 90 }, speed: "balanced",
    contextCapacity: 200_000, writeCapable: false, reasoning: 90, underlyingFamily: null,
  });
  return { root, repo, login, home, env };
}

/**
 * Claude writing, Codex reviewing, each in its own envelope.
 *
 * The reviewer is the only thing that reaches the read path in this session, so the shadow executor
 * answers a review verdict: a fake that returned "work" here would fail the run with
 * `WRITE_REVIEW_INVALID`, which is the runner refusing to call a non-review a review.
 */
class FakeBigWriteClis {
  readonly reviews: { readonly providerId: string; readonly cwd: string }[] = [];
  readonly writes: { readonly providerId: string; readonly cwd: string }[] = [];

  readonly shadow: ShadowProcessExecutor = {
    run: async (input: { readonly plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> => {
      this.reviews.push({ providerId: input.plan.providerId, cwd: input.plan.cwd });
      const verdict = JSON.stringify({ kind: "review", verdict: "approve", findings: [] });
      return {
        spawned: true, exitCode: 0, timedOut: false, durationMs: 5, stderr: "", removedEnvironmentKeys: Object.freeze([]),
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "01a09d2f-73db-72b3-8029-6a4786c2eb01" }),
          JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: verdict } }),
        ].join("\n"),
      };
    },
  };

  readonly writer: WriteProviderExecutor = {
    run: async (input: { readonly plan: WriteProviderPlan }): Promise<WriteProviderResult> => {
      this.writes.push({ providerId: input.plan.providerId, cwd: input.plan.cwd });
      const target = join(input.plan.cwd, "auth", "login.ts");
      writeFileSync(target, `${readFileSync(target, "utf8")}// reviewed change\n`);
      return {
        spawned: true, exitCode: 0, timedOut: false, durationMs: 5, stderr: "", removedEnvironmentKeys: Object.freeze([]),
        stdout: JSON.stringify({ result: JSON.stringify({ summary: "tightened the acceptance check" }) }),
      };
    },
  };
}

function sessionOf(repo: string, env: NodeJS.ProcessEnv, clis: FakeBigWriteClis, answers: readonly string[]) {
  const remaining = [...answers];
  const asked: string[] = [];
  let out = "";
  let err = "";
  return {
    text: () => `${out}${err}`,
    // What the session put to the operator. A prompt is not printed to stdout — it is the question
    // the terminal asks — so the only way to assert on it is to record it here.
    asked: () => asked.join("\n"),
    run: () => runRepl({
      cwd: repo,
      env,
      animate: false,
      colour: false,
      stdout: (text) => { out += text; },
      stderr: (text) => { err += text; },
      ask: async (question: string) => { asked.push(question); return remaining.shift() ?? null; },
      executor: clis.shadow,
      writeExecutor: clis.writer,
      discoverAll: async () => [snapshot("anthropic"), snapshot("openai")],
      probeCapabilities: async () => ({ features: { sessionIdPinning: { supported: true } } }),
      measureCapabilities: async () => ({}),
      // The real profile hash, not a placeholder: the reviewer's own gate recomputes it from the
      // attestation's dropped set, and a proof that does not match is exactly what it refuses.
      verifyCodexIsolation: async (item: ProviderSnapshot) => ({
        providerId: "openai" as const, source: "sandbox-self-test" as const,
        version: item.version.value ?? "0.0.0",
        platform: process.platform === "darwin" ? "darwin" as const : "linux" as const,
        profileHash: codexIsolationProfileHash(), droppedFeatureKeys: [],
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    }),
  };
}

function scopeOf(f: ReturnType<typeof fixture>) {
  return executionScopeFor(new ProjectRegistry(f.home).loadFile(join(f.repo, ".brain", "project.json")), f.repo);
}

test("a T3 write in a DIRECT session is escalated, reviewed across providers, and left for the operator to merge", async () => {
  const f = fixture("escalated");
  const clis = new FakeBigWriteClis();
  const session = sessionOf(f.repo, f.env, clis, [BIG_TASK, "y", "/exit"]);
  try {
    assert.equal(await session.run(), 0, session.text());
    const text = session.text();

    // The plan says what it is doing with the boundary the session asked for, before the prompt.
    assert.match(text, /escalated: T3/, "the plan names the escalation and its reason");
    assert.match(text, /reviewer required/, "and that the reviewer is not optional");
    assert.match(text, /isolated worktree/, "and where the work will happen");
    assert.match(session.asked(), /never your checkout; merging is yours/, "the prompt says what it will not touch");

    // One worker and one reviewer, from two different subscriptions.
    assert.equal(clis.writes.length, 1, "one write worker");
    assert.equal(clis.writes[0]!.providerId, "anthropic");
    assert.equal(clis.reviews.length, 1, "and one reviewer");
    assert.equal(clis.reviews[0]!.providerId, "openai", "from the other subscription");

    // The work happened in a worktree under BrainGate's own storage, not in the workspace.
    const scope = scopeOf(f);
    const worktreeRoot = join(scope.project.storageDir, "worktrees");
    assert.equal(existsSync(worktreeRoot), true, "a worktree was prepared under project storage");
    assert.equal(clis.writes[0]!.cwd.startsWith(realpathSync.native(worktreeRoot)), true, `the worker ran in the worktree, not in ${clis.writes[0]!.cwd}`);
    assert.equal(readFileSync(f.login, "utf8"), "export function accept(): boolean { return false; }\n", "the operator's own file is untouched");
    assert.equal(git(f.repo, ["status", "--porcelain"]), "", "and their checkout is clean");
    assert.equal(git(f.repo, ["log", "--oneline"]).split("\n").length, 1, "nothing was committed for them");

    // Nothing was merged, and the receipt says so in the words the operator reads.
    assert.match(text, /No merge performed/);
    const ledger = new TaskLedger(scope.project);
    try {
      const task = ledger.listTasks()[0]!;
      const events = ledger.receipt(task.taskId).events;
      const escalation = events.find((event) => event.kind === "write.escalated");
      assert.notEqual(escalation, undefined, "the escalation is on the task's own record");
      assert.deepEqual(
        { from: (escalation!.payload as { from: string }).from, to: (escalation!.payload as { to: string }).to, reason: (escalation!.payload as { reason: string }).reason },
        { from: "direct", to: "worktree", reason: "T3" },
      );
      assert.equal((task.route as { readonly policy?: string } | null)?.policy, "worktree", "and the route the task recorded is the one that ran");
      assert.equal(events.some((event) => event.kind === "write.review.approve"), true, "the reviewer's verdict is recorded");
    } finally { ledger.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a dirty checkout gets one message, no prompt, and nothing is spent", async () => {
  const f = fixture("dirty");
  // The ordinary state of someone in the middle of something: a tracked edit and an untracked file.
  writeFileSync(f.login, "export function accept(): boolean { return true; }\n");
  writeFileSync(join(f.repo, "scratch.txt"), "notes to self\n");
  const clis = new FakeBigWriteClis();
  // Only two answers: the request and `/exit`. A confirmation prompt here would consume `/exit`
  // and the session would hang or run — which is the point of asserting the count of asks below.
  const session = sessionOf(f.repo, f.env, clis, [BIG_TASK, "/exit"]);
  try {
    assert.equal(await session.run(), 0, session.text());
    const text = session.text();
    assert.match(text, /This is a T3 change/, "the message says what kind of change this is");
    assert.match(text, /isolated worktree with a reviewer/, "and where it has to happen");
    assert.match(text, /2 changed file\(s\)/, "and how much is in the way");
    assert.match(text, /Commit or stash your work, then ask again/, "and what to do about it");
    assert.match(text, /BrainGate never stashes for you/, "and what it will not do on their behalf");
    assert.doesNotMatch(session.asked(), /Run it\?/, "there is nothing to confirm");

    assert.equal(clis.writes.length, 0, "no worker ran");
    assert.equal(clis.reviews.length, 0, "no reviewer ran either");
    assert.equal(readFileSync(f.login, "utf8"), "export function accept(): boolean { return true; }\n", "their edit is exactly as they left it");
    assert.equal(readFileSync(join(f.repo, "scratch.txt"), "utf8"), "notes to self\n");
    const scope = scopeOf(f);
    const worktreeRoot = join(scope.project.storageDir, "worktrees");
    assert.equal(existsSync(worktreeRoot) && readdirSync(worktreeRoot).length > 0, false, "no worktree was created");
    const ledger = new TaskLedger(scope.project);
    try { assert.equal(ledger.listTasks().length, 0, "and no task exists: nothing was recorded because nothing ran"); }
    finally { ledger.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
