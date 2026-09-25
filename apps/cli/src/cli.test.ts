import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import { CODEX_PROBE_VERSION } from "@braingate/shadow";
import {
  codexIsolationProfileHash,
  type CodexIsolationAttestation,
  type ShadowInvocationPlan,
  type ShadowProcessExecutor,
  type ShadowProcessResult,
} from "@braingate/shadow";
import type { RegisteredProject } from "@braingate/core";
import type { WriteProviderExecutor, WriteProviderPlan, WriteProviderResult } from "@braingate/write";
import { runCli } from "./cli.js";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return String(result.stdout ?? "").trim();
}

function snapshot(): ProviderSnapshot {
  const observedAt = "2026-09-07T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId: "anthropic", displayName: "Claude Code", binary: "claude",
    available: obs(true), version: obs("2.1.248"), authState: obs("authenticated"), authMode: obs("subscription"),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt }, removedBillingOverrides: [], warnings: [],
  };
}

function openaiSnapshot(auth: "subscription" | "api" = "subscription"): ProviderSnapshot {
  const observedAt = "2026-09-07T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId: "openai", displayName: "OpenAI Codex", binary: "codex",
    available: obs(true), version: obs("codex-cli 0.152.0"), authState: obs("authenticated"), authMode: obs(auth),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt }, removedBillingOverrides: [], warnings: [],
  };
}

function isolation(): CodexIsolationAttestation {
  return {
    providerId: "openai",
    source: "sandbox-self-test",
    droppedFeatureKeys: [],
    version: "codex-cli 0.152.0",
    platform: process.platform === "darwin" ? "darwin" : "linux",
    probeVersion: CODEX_PROBE_VERSION,
    profileHash: codexIsolationProfileHash(),
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

class FakeExecutor implements ShadowProcessExecutor {
  readonly calls: ShadowInvocationPlan[] = [];
  /** Read while the call is in flight: a snapshot is released when the task ends. */
  snapshotHadContent = false;
  async run(input: { project: RegisteredProject; plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> {
    this.calls.push(input.plan);
    // The role is in the payload the caller sent, which is how a fake knows whether it is answering as
    // the primary or reviewing — the same distinction the real CLIs are given.
    const role = input.plan.stdin === null ? null : (JSON.parse(input.plan.stdin) as { readonly role?: string }).role ?? null;
    if (input.plan.workspaceMode === "staged-read-snapshot" && input.plan.workspaceRoot !== undefined) {
      this.snapshotHadContent = existsSync(input.plan.workspaceRoot) && readdirSync(input.plan.workspaceRoot).length > 0;
    }
    if (role === "primary") {
      const work = JSON.stringify({ kind: "work", output: "safe ephemeral answer" });
      if (input.plan.providerId === "openai") {
        return {
          spawned: true,
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "PRIVATE_REASONING_MUST_NOT_PERSIST" } }),
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: work } }),
          ].join("\n"),
          stderr: "",
          timedOut: false,
          durationMs: 7,
          removedEnvironmentKeys: [],
        };
      }
      return { spawned: true, exitCode: 0, stdout: JSON.stringify({ result: work }), stderr: "", timedOut: false, durationMs: 5, removedEnvironmentKeys: [] };
    }
    const review = JSON.stringify({ kind: "review", verdict: "approve", findings: [] });
    if (input.plan.providerId === "openai") {
      return { spawned: true, exitCode: 0, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: review } }), stderr: "", timedOut: false, durationMs: 7, removedEnvironmentKeys: [] };
    }
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ result: review }), stderr: "", timedOut: false, durationMs: 5, removedEnvironmentKeys: [] };
  }
}

class FakeWriteExecutor implements WriteProviderExecutor {
  readonly calls: WriteProviderPlan[] = [];
  async run(input: { plan: WriteProviderPlan }): Promise<WriteProviderResult> {
    this.calls.push(input.plan);
    writeFileSync(join(input.plan.cwd, "app.txt"), "after\n");
    return { spawned: true, exitCode: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "", timedOut: false, durationMs: 9, removedEnvironmentKeys: [] };
  }
}

function fixture(withCodex = false) {
  const root = mkdtempSync(join(tmpdir(), "braingate-cli-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "app.txt"), "before\n");
  git(repo, ["add", "app.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  const manifest = join(root, "project.json");
  writeFileSync(manifest, JSON.stringify({ project_id: "sample", name: "Sample", repositories: [repo] }));
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  const state = resolveOperatorState(env, root);
  const catalog = new ModelCatalog(state.modelCatalogPath);
  catalog.upsert({
    providerId: "anthropic", modelId: "claude-test", quotaPool: "claude-subscription",
    capabilities: { coder: 90, reviewer: 90, judge: 90 }, speed: "balanced", contextCapacity: 200_000,
    writeCapable: true, reasoning: 90, underlyingFamily: null,
  });
  if (withCodex) {
    catalog.upsert({
      providerId: "openai", modelId: "codex-test", quotaPool: "chatgpt-subscription",
      capabilities: { coder: 100, reviewer: 100, judge: 100 }, speed: "balanced", contextCapacity: 200_000,
      writeCapable: false, reasoning: 100, underlyingFamily: null,
    });
  }
  return { root, repo, manifest, home, env };
}

function io() {
  let stdout = "";
  let stderr = "";
  return { stdout: (value: string) => { stdout += value; }, stderr: (value: string) => { stderr += value; }, out: () => stdout, err: () => stderr };
}

test("discover and doctor use injected metadata discovery and never invoke a model executor", async () => {
  const f = fixture();
  const fake = new FakeExecutor();
  const output = io();
  let isolationChecks = 0;
  const deps = {
    cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: fake,
    verifyCodexIsolation: async () => { isolationChecks += 1; return isolation(); },
    stdout: output.stdout, stderr: output.stderr,
  };
  assert.equal((await runCli(["discover", "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["doctor", "--project", f.manifest, "--json"], deps)).exitCode, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(isolationChecks, 0);
  assert.doesNotMatch(output.out(), /safe ephemeral answer/);
});

test("doctor self-tests ChatGPT-authenticated Codex locally without model execution", async () => {
  const f = fixture(true);
  const fake = new FakeExecutor();
  const output = io();
  let isolationChecks = 0;
  const result = await runCli(["doctor", "--project", f.manifest, "--json"], {
    cwd: f.repo,
    env: f.env,
    discoverAll: async () => [snapshot(), openaiSnapshot()],
    verifyCodexIsolation: async () => { isolationChecks += 1; return isolation(); },
    executor: fake,
    stdout: output.stdout,
    stderr: output.stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(isolationChecks, 1);
  assert.equal(fake.calls.length, 0);
  assert.match(output.out(), /"eligible": true/);
  assert.match(output.out(), /sandbox-self-test/);
});

test("shadow plan and run without --execute make zero provider calls and never print the raw task in JSON", async () => {
  const f = fixture();
  const fake = new FakeExecutor();
  const task = "Where is the theme config? UNIQUE_PRIVATE_PROMPT";
  const first = io();
  const deps = { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: fake, stdout: first.stdout, stderr: first.stderr };
  assert.equal((await runCli(["shadow", "plan", "--project", f.manifest, "--task", task, "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["shadow", "run", "--project", f.manifest, "--task", task, "--json"], deps)).exitCode, 0);
  assert.equal(fake.calls.length, 0);
  assert.doesNotMatch(first.out(), /UNIQUE_PRIVATE_PROMPT/);
});

test("high-risk shadow plan verifies Codex isolation but makes zero provider model calls", async () => {
  const f = fixture(true);
  const fake = new FakeExecutor();
  const output = io();
  let isolationChecks = 0;
  // Reviewer routing needs a task that actually requires a reviewer. Reading about auth no
  // longer does — a question damages nothing — so the fixture is a breadth-and-judgement task,
  // which is the shape that genuinely earns a second opinion.
  const task = "Audit the auth session storage across the whole application UNIQUE_AUTH_PROMPT";
  const result = await runCli(["shadow", "plan", "--project", f.manifest, "--task", task, "--json"], {
    cwd: f.repo,
    env: f.env,
    discoverAll: async () => [snapshot(), openaiSnapshot()],
    verifyCodexIsolation: async () => { isolationChecks += 1; return isolation(); },
    executor: fake,
    stdout: output.stdout,
    stderr: output.stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(isolationChecks, 1);
  assert.equal(fake.calls.length, 0);
  assert.match(output.out(), /"providerId": "anthropic"/);
  assert.match(output.out(), /"providerId": "openai"/);
  assert.match(output.out(), /"workspaceMode": "staged-clean"/);
  assert.doesNotMatch(output.out(), /UNIQUE_AUTH_PROMPT/);
});

// Two different things were asserted together here, and only one of them is an invariant.
//
// Provider output must never persist: it can carry code, file contents and reasoning that the
// operator never chose to write down. The operator's own request is not that — it is what they
// typed — and keeping it out left BrainGate unable to say what any past task had been about.
test("a provider's answer never reaches the ledger, and the operator's own request does", async () => {
  const f = fixture();
  const fake = new FakeExecutor();
  const executeOut = io();
  const deps = { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: fake, stdout: executeOut.stdout, stderr: executeOut.stderr };
  const executed = await runCli(["shadow", "run", "--project", f.manifest, "--task", "Where is the theme config?", "--execute"], deps);
  assert.equal(executed.exitCode, 0);
  assert.equal(fake.calls.length, 1);
  assert.match(executeOut.out(), /safe ephemeral answer/);

  const statusOut = io();
  const status = await runCli(["status", "--project", f.manifest, "--json"], { cwd: f.repo, env: f.env, stdout: statusOut.stdout, stderr: statusOut.stderr });
  assert.equal(status.exitCode, 0);
  assert.doesNotMatch(statusOut.out(), /safe ephemeral answer/, "provider output must stay ephemeral");
  assert.match(statusOut.out(), /Where is the theme config/, "the operator must be able to read their own history");
});

test("high-risk execute routes Claude primary then self-tested Codex reviewer and does not persist reasoning", async () => {
  const f = fixture(true);
  const fake = new FakeExecutor();
  const output = io();
  let isolationChecks = 0;
  const executed = await runCli(["shadow", "run", "--project", f.manifest, "--task", "Audit the auth session storage across the whole application", "--execute"], {
    cwd: f.repo,
    env: f.env,
    discoverAll: async () => [snapshot(), openaiSnapshot()],
    verifyCodexIsolation: async () => { isolationChecks += 1; return isolation(); },
    executor: fake,
    stdout: output.stdout,
    stderr: output.stderr,
  });
  assert.equal(executed.exitCode, 0);
  assert.equal(isolationChecks, 1);
  // A self-tested Codex is now eligible for the read-primary role, and the stronger model wins it —
  // reading a snapshot rather than the checkout. The reviewer it leaves has to be another provider.
  assert.deepEqual(fake.calls.map((call) => call.providerId), ["openai", "anthropic"]);
  assert.equal(fake.calls[0]?.workspaceMode, "staged-read-snapshot");
  assert.equal(fake.calls[0]?.workspaceRoot?.includes(f.repo) ?? true, false, "the snapshot is not the checkout");
  assert.equal(fake.snapshotHadContent, true, "the provider read a snapshot with the project's content in it");
  assert.equal(fake.calls[1]?.workspaceMode, "project");
  assert.match(output.out(), /safe ephemeral answer/);
  assert.doesNotMatch(output.out(), /PRIVATE_REASONING_MUST_NOT_PERSIST/);

  const statusOut = io();
  assert.equal((await runCli(["status", "--project", f.manifest, "--json"], { cwd: f.repo, env: f.env, stdout: statusOut.stdout, stderr: statusOut.stderr })).exitCode, 0);
  // Neither the answer nor the model's private reasoning is written down. The request is, and
  // deliberately: it is the operator's own text, and it is what makes the ledger readable.
  assert.doesNotMatch(statusOut.out(), /safe ephemeral answer|PRIVATE_REASONING_MUST_NOT_PERSIST/);
  assert.match(statusOut.out(), /Audit the auth session storage/);
});

test("failed Codex isolation removes it from reviewer routing before any provider model call", async () => {
  const f = fixture(true);
  const fake = new FakeExecutor();
  const output = io();
  let isolationChecks = 0;
  const result = await runCli(["shadow", "plan", "--project", f.manifest, "--task", "Audit the auth session storage across the whole application", "--json"], {
    cwd: f.repo,
    env: f.env,
    discoverAll: async () => [snapshot(), openaiSnapshot()],
    verifyCodexIsolation: async () => { isolationChecks += 1; throw new Error("sandbox denied outside-root invariant"); },
    executor: fake,
    stdout: output.stdout,
    stderr: output.stderr,
  });
  // The claim is that a failed self-test takes Codex out of reviewer routing before anything is
  // spent — not that the task dies. Another reviewer may exist, and refusing to plan at all
  // when one does would be a worse outcome than routing to it.
  assert.equal(isolationChecks, 1);
  assert.equal(fake.calls.length, 0);
  const roles = (result.data as { roles?: readonly { role: string; model: { providerId: string } }[] }).roles ?? [];
  assert.equal(roles.some((entry) => entry.role === "reviewer" && entry.model.providerId === "openai"), false, "Codex must not be routed on a failed self-test");
  // The reason the self-test failed is the provider's, and it is not echoed into BrainGate's output.
  assert.doesNotMatch(output.out() + output.err(), /sandbox denied outside-root invariant/);
});

test("API-authenticated Codex is never self-tested or accepted as subscription reviewer", async () => {
  const f = fixture(true);
  const fake = new FakeExecutor();
  const output = io();
  let isolationChecks = 0;
  const result = await runCli(["shadow", "plan", "--project", f.manifest, "--task", "Audit the auth session storage across the whole application", "--json"], {
    cwd: f.repo,
    env: f.env,
    discoverAll: async () => [snapshot(), openaiSnapshot("api")],
    verifyCodexIsolation: async () => { isolationChecks += 1; return isolation(); },
    executor: fake,
    stdout: output.stdout,
    stderr: output.stderr,
  });
  assert.equal(isolationChecks, 0, "an API-billed Codex is refused before it is worth self-testing");
  assert.equal(fake.calls.length, 0);
  const roles = (result.data as { roles?: readonly { role: string; model: { providerId: string } }[] }).roles ?? [];
  assert.equal(roles.some((entry) => entry.model.providerId === "openai"), false, "direct billing is never routed to");
});

test("shadow preflight rejects cwd outside registered repository before executor call", async () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  const fake = new FakeExecutor();
  const output = io();
  const result = await runCli(["shadow", "plan", "--project", f.manifest, "--task", "Where is the theme config?", "--json"], { cwd: outside, env: f.env, discoverAll: async () => [snapshot()], executor: fake, stdout: output.stdout, stderr: output.stderr });
  assert.equal(result.exitCode, 1);
  assert.equal(fake.calls.length, 0);
  assert.match(output.err(), /SHADOW_CWD_ESCAPE/);
});

test("write plan and unexecuted run make zero model calls and zero worktrees", async () => {
  const f = fixture();
  const writer = new FakeWriteExecutor();
  const output = io();
  const task = "change the button label UNIQUE_WRITE_PROMPT";
  const deps = { cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], writeExecutor: writer, stdout: output.stdout, stderr: output.stderr };
  assert.equal((await runCli(["write", "plan", "--project", f.manifest, "--task", task, "--no-review", "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["write", "run", "--project", f.manifest, "--task", task, "--no-review", "--json"], deps)).exitCode, 0);
  assert.equal(writer.calls.length, 0);
  assert.match(output.out(), /"createsWorktree": false/);
  assert.match(output.out(), /"mergeAvailable": false/);
  assert.doesNotMatch(output.out(), /UNIQUE_WRITE_PROMPT/);
});

test("write run --execute changes an isolated worktree and never the source checkout", async () => {
  const f = fixture();
  const writer = new FakeWriteExecutor();
  const output = io();
  const result = await runCli(["write", "run", "--project", f.manifest, "--task", "change the button label", "--no-review", "--execute", "--json"], {
    cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], writeExecutor: writer, stdout: output.stdout, stderr: output.stderr,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(writer.calls.length, 1);
  assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "before\n");
  assert.equal(git(f.repo, ["status", "--porcelain"]), "");
  assert.match(output.out(), /"approvalRequired": true/);
  assert.match(output.out(), /"mergePerformed": false/);
  assert.match(output.out(), /app\.txt/);
});

// A high-risk write is not refused for its size any more: under the worktree policy this path uses,
// it is admitted with a mandatory reviewer from another provider (ADR 0021). On a machine with one
// signed-in provider there is no such reviewer, so it still fails — before any provider call, with
// a clean checkout, and now naming what is missing and how to supply it.
test("write high-risk task fails before provider execution when no independent reviewer exists", async () => {
  const f = fixture();
  const writer = new FakeWriteExecutor();
  const output = io();
  const result = await runCli(["write", "run", "--project", f.manifest, "--task", "fix auth login and session security", "--no-review", "--execute", "--json"], {
    cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], writeExecutor: writer, stdout: output.stdout, stderr: output.stderr,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(writer.calls.length, 0);
  assert.match(output.err(), /WRITE_REVIEWER_UNAVAILABLE/);
  assert.match(output.err(), /Sign in to a second CLI/);
  assert.equal(git(f.repo, ["status", "--porcelain"]), "");
});

test("models/status/dashboard safe paths do not invoke provider executor", async () => {
  const f = fixture();
  const fake = new FakeExecutor();
  const output = io();
  let dashboardStarts = 0;
  const deps = {
    cwd: f.repo, env: f.env, discoverAll: async () => [snapshot()], executor: fake,
    stdout: output.stdout, stderr: output.stderr,
    startDashboard: async () => { dashboardStarts += 1; return { url: "http://127.0.0.1:4321/" }; },
  };
  assert.equal((await runCli(["models", "validate", "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["models", "list", "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["status", "--project", f.manifest, "--json"], deps)).exitCode, 0);
  assert.equal((await runCli(["dashboard", "--project", f.manifest, "--json"], deps)).exitCode, 0);
  assert.equal(dashboardStarts, 1);
  assert.equal(fake.calls.length, 0);
});

// ADR 0008/0009. Two providers, two different answers to the same question — "may BrainGate
// run this?" — and the difference has to be visible on the command line, because a refusal
// nobody can act on is the same as a missing feature.
test("providers list says which roles each provider may take and why", async () => {
  const f = fixture();
  const output = io();
  const result = await runCli(["providers", "list", "--json"], { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr });
  assert.equal(result.exitCode, 0);
  const rows = result.data as readonly { providerId: string; acceptance: unknown; roles: readonly { role: string; enabled: boolean; reason: string | null }[] }[];
  const google = rows.find((row) => row.providerId === "google")!;
  assert.equal(google.acceptance, null);
  assert.equal(google.roles.every((entry) => !entry.enabled), true);
  assert.match(google.roles[0]!.reason ?? "", /braingate providers accept google/);

  const xai = rows.find((row) => row.providerId === "xai")!;
  // Grok's isolation is proven per run rather than accepted, so the policy opens its staged
  // roles and closes the one that would need the checkout.
  assert.equal(xai.roles.find((entry) => entry.role === "planner")?.enabled, true);
  assert.equal(xai.roles.find((entry) => entry.role === "primary")?.enabled, false);
});

test("accepting a provider opens its staged roles, and revoking closes them again", async () => {
  const f = fixture();
  const output = io();
  const deps = { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr };

  const accepted = await runCli(["providers", "accept", "google"], deps);
  assert.equal(accepted.exitCode, 0);
  // The operator has to be told what they just agreed to, in the same breath as agreeing.
  assert.match(output.out(), /elsewhere on this machine is unchecked/);
  assert.match(output.out(), /Staged roles only/);
  assert.match(output.out(), /braingate providers revoke google/);

  const listed = (await runCli(["providers", "list", "--json"], deps)).data as readonly { providerId: string; roles: readonly { role: string; enabled: boolean; acceptedByOperator: boolean }[] }[];
  const google = listed.find((row) => row.providerId === "google")!;
  assert.equal(google.roles.find((entry) => entry.role === "planner")?.enabled, true);
  assert.equal(google.roles.find((entry) => entry.role === "planner")?.acceptedByOperator, true);
  // Acceptance widens which providers may be asked, never what one may see.
  assert.equal(google.roles.find((entry) => entry.role === "primary")?.enabled, false);

  assert.equal((await runCli(["providers", "revoke", "google"], deps)).exitCode, 0);
  const after = (await runCli(["providers", "list", "--json"], deps)).data as readonly { providerId: string; roles: readonly { enabled: boolean }[] }[];
  assert.equal(after.find((row) => row.providerId === "google")!.roles.every((entry) => !entry.enabled), true);
});

test("accepting a provider that needs no acceptance is refused rather than recorded", async () => {
  const f = fixture();
  const output = io();
  const deps = { cwd: f.repo, env: f.env, stdout: output.stdout, stderr: output.stderr };
  // Recording a decision that changes nothing would imply the operator is taking a risk they
  // are not, and would quietly become the reason a later reader thinks they accepted one.
  for (const providerId of ["anthropic", "xai"] as const) {
    const result = await runCli(["providers", "accept", providerId], deps);
    assert.equal(result.exitCode, 1);
    assert.match(output.err(), /does not run on operator acceptance/);
  }
  assert.equal((await runCli(["providers", "accept", "not-a-provider"], deps)).exitCode, 1);
});

test("--version names the package version, before anything reads the operator's state", async () => {
  // A bug report asks for the version first, and the report that most needs it is the one about a
  // state directory BrainGate cannot open — so the answer must not depend on that directory.
  const expected = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const output = io();
  const deps = { env: { BRAINGATE_HOME: "\u0000not-a-path" }, stdout: output.stdout, stderr: output.stderr };
  assert.equal((await runCli(["--version"], deps)).exitCode, 0);
  assert.equal(output.out().trim(), `braingate ${expected}`);
  const json = await runCli(["--version", "--json"], deps);
  assert.deepEqual(json.data, { version: expected });
});
