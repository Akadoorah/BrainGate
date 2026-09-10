import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The only tests in this repository that let a provider actually answer.
 *
 * Every other suite drives a fake executor that returns a perfectly shaped response, which
 * proves BrainGate's own plumbing but says nothing about whether a real CLI ever produced a
 * real result. That gap hid a run of defects: the account-name environment variable stripped
 * from provider subprocesses, a role contract no model had ever satisfied, turn and wall-clock
 * ceilings that no real repository fit inside, and a write path disabled by its own hardening.
 * Each shipped green.
 *
 * These tests spend real subscription quota, so they are opt-in and never run in CI:
 *
 *   BRAINGATE_INTEGRATION=1 pnpm --filter @braingate/cli test
 *
 * They assert outcomes, not arguments: an answer that could only come from reading this
 * repository, and a file whose bytes actually changed.
 */

const ENABLED = process.env.BRAINGATE_INTEGRATION === "1";
const SKIP = ENABLED ? false : "opt-in: set BRAINGATE_INTEGRATION=1 (spends real subscription quota)";

// Distinctive enough that it cannot appear by chance or be guessed without reading the file.
const CANARY = "BRAINGATE_INTEGRATION_CANARY_7F3A9C";
const LAUNCHER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "braingate.mjs");

interface Cli {
  readonly repo: string;
  readonly home: string;
  readonly run: (args: readonly string[], timeoutMs?: number) => { status: number | null; stdout: string; stderr: string };
  readonly git: (args: readonly string[]) => string;
  readonly cleanup: () => void;
}

function makeCli(): Cli {
  const root = mkdtempSync(join(tmpdir(), "braingate-integration-"));
  const repo = join(root, "sample-service");
  const home = join(root, "brain-home");
  mkdirSync(repo);

  const git = (args: readonly string[]): string => {
    const result = spawnSync("git", [...args], { cwd: repo, encoding: "utf8", shell: false });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(result.stderr || result.stdout)}`);
    return String(result.stdout ?? "").trim();
  };

  git(["init", "-b", "main"]);
  git(["config", "user.email", "integration@example.invalid"]);
  git(["config", "user.name", "BrainGate Integration"]);
  // The answer to the read task exists only here, so a model that does not read the working
  // tree cannot produce it.
  writeFileSync(join(repo, "SERVICE.md"), `# Sample Service\n\nThe build identifier for this service is ${CANARY}.\n`);
  writeFileSync(join(repo, "labels.txt"), "empty-state: Nothing here yet\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);

  const run = (args: readonly string[], timeoutMs = 15 * 60_000) => {
    const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
      cwd: repo,
      encoding: "utf8",
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, BRAINGATE_HOME: home },
    });
    return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  };

  return { repo, home, run, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Copies the operator's real model catalog into the isolated home.
 *
 * The catalog holds provider-owned model ids and capacities that BrainGate deliberately never
 * invents, so the test reuses whatever the operator has already verified rather than pinning
 * ids of its own that would rot with every provider release.
 */
function useRealCatalog(home: string): void {
  const source = join(homedir(), ".braingate", "global", "models.json");
  if (!existsSync(source)) {
    throw new Error("No model catalog found. Run `braingate models add --definition <file>` before the integration tests.");
  }
  const globalDir = join(home, "global");
  mkdirSync(globalDir, { recursive: true, mode: 0o700 });
  copyFileSync(source, join(globalDir, "models.json"));
}

/**
 * Copies the operator's recorded provider acceptances into the isolated home.
 *
 * A provider BrainGate cannot scope per invocation runs only on the operator's own recorded
 * decision (ADR 0008). An isolated home starts with none, so a test that did not carry them
 * across would prove that provider unreachable rather than that it works. Copied, never
 * written: this reads their decision, it does not make one.
 */
function useRealAcceptances(home: string): void {
  const source = join(homedir(), ".braingate", "global", "provider-acceptance.json");
  if (!existsSync(source)) return;
  const globalDir = join(home, "global");
  mkdirSync(globalDir, { recursive: true, mode: 0o700 });
  copyFileSync(source, join(globalDir, "provider-acceptance.json"));
}

function register(cli: Cli): void {
  useRealCatalog(cli.home);
  useRealAcceptances(cli.home);
  const init = cli.run(["init", "--project-id", "integration-sample", "--name", "Integration Sample"], 60_000);
  assert.equal(init.status, 0, `init failed: ${init.stdout}${init.stderr}`);
}

test("a read task returns an answer that could only come from reading the repository", { skip: SKIP }, async () => {
  const cli = makeCli();
  try {
    register(cli);

    const preflight = cli.run(["dogfood", "preflight"], 120_000);
    assert.equal(preflight.status, 0, `preflight failed: ${preflight.stdout}${preflight.stderr}`);
    assert.match(preflight.stdout, /ask=ready/);

    // Without --execute nothing may reach a provider.
    const plan = cli.run(["dogfood", "ask", "plan", "--task", "What build identifier is recorded in SERVICE.md?"], 120_000);
    assert.equal(plan.status, 0, `plan failed: ${plan.stdout}${plan.stderr}`);
    assert.match(plan.stdout, /Zero provider model calls/);
    assert.doesNotMatch(plan.stdout, new RegExp(CANARY));

    const run = cli.run(["dogfood", "ask", "run", "--task", "Which build identifier does SERVICE.md record? Answer with it exactly.", "--execute"]);
    // Exit status is part of the contract: 0 only when the task completed cleanly. A reviewer
    // asking for changes exits 1, so a caller can tell "done" from "needs your eyes".
    assert.equal(run.status, 0, `run failed: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /outcome=completed/);
    // The whole chain in one assertion: the provider was invoked with a usable environment,
    // it read the working tree, it satisfied the role contract, and the answer reached stdout.
    assert.match(run.stdout, new RegExp(CANARY), "the answer did not contain the canary, so nothing actually read the repository");
  } finally {
    cli.cleanup();
  }
});

test("a write task changes the task worktree and leaves the source checkout byte-identical", { skip: SKIP }, async () => {
  const cli = makeCli();
  try {
    register(cli);

    const before = readFileSync(join(cli.repo, "labels.txt"), "utf8");
    const headBefore = cli.git(["rev-parse", "HEAD"]);

    const plan = cli.run(["dogfood", "write", "plan", "--task", "In labels.txt, change the empty-state label to 'Nothing here yet, add your first item'"], 120_000);
    assert.equal(plan.status, 0, `write plan failed: ${plan.stdout}${plan.stderr}`);
    assert.match(plan.stdout, /Zero provider model calls\. Zero worktrees\./);

    const run = cli.run(["dogfood", "write", "run", "--task", "In labels.txt, change the empty-state label to 'Nothing here yet, add your first item'", "--execute"]);
    assert.equal(run.status, 0, `write run failed: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /Changed: labels\.txt/, "the provider produced no reviewable change");
    assert.match(run.stdout, /No merge performed/);

    // The invariant, checked against the filesystem rather than against a log line.
    assert.equal(readFileSync(join(cli.repo, "labels.txt"), "utf8"), before, "the source checkout was modified");
    assert.equal(cli.git(["rev-parse", "HEAD"]), headBefore, "HEAD moved");
    assert.equal(cli.git(["status", "--porcelain"]), "", "the source checkout is no longer clean");

    // The edit exists, in the task worktree, where the only merge is a human one.
    const worktrees = cli.git(["worktree", "list"]).split("\n").filter((line) => line.includes("braingate/task-"));
    assert.equal(worktrees.length, 1, `expected exactly one task worktree, got ${String(worktrees.length)}`);
    const worktreePath = worktrees[0]!.split(/\s+/)[0]!;
    const edited = readFileSync(join(worktreePath, "labels.txt"), "utf8");
    assert.notEqual(edited, before, "the worktree copy is unchanged, so no edit was actually made");
    assert.match(edited, /add your first item/);
  } finally {
    cli.cleanup();
  }
});

/**
 * Every staged provider, answering a real role contract.
 *
 * The fakes prove BrainGate builds the command it meant to build. Only this proves the provider
 * on the other side accepts it — the schema flag, the staged workspace, the input route, and the
 * envelope the answer comes back in. Each of those changed under BrainGate at least once without
 * a single test going red.
 */
test("each staged provider satisfies the role contract from its own CLI", { skip: SKIP }, async () => {
  const { ProviderDiscovery } = await import("@braingate/providers");
  const { NodeShadowProcessExecutor, SubscriptionShadowAgentInvoker, GrokIsolationVerifier, CodexIsolationVerifier } = await import("@braingate/shadow");
  const { ProjectRegistry } = await import("@braingate/core");

  const cli = makeCli();
  try {
    register(cli);

    const registry = new ProjectRegistry(cli.home);
    const project = registry.loadFile(join(cli.repo, ".brain", "project.json"));

    const snapshots = await new ProviderDiscovery().discoverAll();
    const catalogue = JSON.parse(readFileSync(join(cli.home, "global", "models.json"), "utf8")) as {
      entries: readonly { readonly definition: { readonly providerId: string; readonly modelId: string; readonly quotaPool: string; readonly capabilities: Record<string, number> } }[];
    };

    const answered: string[] = [];
    for (const providerId of ["xai", "google", "openai"] as const) {
      const snapshot = snapshots.find((item) => item.providerId === providerId);
      if (snapshot?.available.value !== true || snapshot.authState.value === "unauthenticated") continue;
      // The cheapest model the operator scored for this role, so the check costs as little as it can.
      const entry = catalogue.entries
        .map((item) => item.definition)
        .filter((definition) => definition.providerId === providerId && typeof definition.capabilities.reviewer === "number")
        .sort((a, b) => (a.capabilities.reviewer ?? 0) - (b.capabilities.reviewer ?? 0))[0];
      if (entry === undefined) continue;

      // No projectPaths here, and deliberately: this test's repository lives in the temp
      // directory, which every Grok profile grants, so the real "can this sandbox still reach
      // the checkout" check would refuse before the provider boundary was ever exercised. That
      // check is covered by its own unit test; what this one is for is the CLI on the far side.
      const grokIsolation = providerId === "xai" ? await new GrokIsolationVerifier().verify(snapshot) : undefined;
      const codexIsolation = providerId === "openai" ? await new CodexIsolationVerifier().verify(snapshot) : undefined;
      const invoker: InstanceType<typeof SubscriptionShadowAgentInvoker> = new SubscriptionShadowAgentInvoker({
        project, cwd: cli.repo, snapshots: [snapshot],
        ...(grokIsolation === undefined ? {} : { grokIsolation }),
        ...(codexIsolation === undefined ? {} : { codexIsolation }),
        acceptances: [{ providerId, source: "operator-accepted-unscoped-provider", acceptedAt: new Date(Date.now() - 60_000).toISOString() }],
        // Antigravity's CLI reports no machine-readable auth mode, so discovery says `unknown`
        // and the operator's own confirmation is what stands in for it — the same record
        // `braingate providers accept` writes.
        attestations: [{ providerId, mode: "subscription", source: "user-confirmed-oauth", observedAt: new Date(Date.now() - 60_000).toISOString() }],
        context: { note: "The reviewed change renames a label and touches nothing else." },
        executor: new NodeShadowProcessExecutor(),
        maxTurns: 8,
      });

      const response: Awaited<ReturnType<typeof invoker.invoke>> = await invoker.invoke({
        role: "reviewer",
        model: { providerId, modelId: entry.modelId, quotaPool: entry.quotaPool },
        phase: "integration",
        task: "A one-line label change. Reply approve.",
        findings: [],
        candidateOutput: "labels.txt: empty-state label reworded.",
      });

      // The contract, satisfied by the provider rather than repaired by the parser.
      assert.equal(response.kind, "review", `${providerId} answered as the wrong role`);
      assert.ok(["approve", "request_changes", "disagree"].includes(response.verdict), `${providerId} returned verdict ${response.verdict}`);
      answered.push(providerId);
    }

    assert.ok(answered.length > 0, "no staged provider was installed and authenticated, so nothing was proven");
  } finally {
    cli.cleanup();
  }
});

/**
 * One task, three subscriptions, and a receipt that says so.
 *
 * The unit tests prove the engine asks for two approaches when the budget allows two. Only this
 * proves two real providers produce them, in parallel, and that an executor on a third can act
 * on both — which is the whole argument for owning several subscriptions rather than the best
 * one.
 */
test("a task the budget allows two approaches for spends two independent subscriptions on them", { skip: SKIP }, async () => {
  const cli = makeCli();
  try {
    register(cli);

    const task = "Redesign how this service reports authentication failures so a caller can tell a expired credential from a revoked one, covering rollback and the security review of each change.";
    const plan = cli.run(["dogfood", "ask", "plan", "--task", task], 180_000);
    assert.equal(plan.status, 0, `plan failed: ${plan.stdout}${plan.stderr}`);
    // T4 is where the budget grants a second approach. If classification lands lower, the rest
    // of this test would silently prove nothing.
    assert.match(plan.stdout, /^T4\//m, `expected a T4 classification, got: ${plan.stdout}`);
    // Grok is legitimately out of reach here: this repository lives in the temp directory, which
    // every Grok sandbox profile grants, so its checkout-reachability self-test refuses. The
    // second approach therefore comes from whichever other independent provider is available.
    assert.match(plan.stdout, /planner-1=/, `the plan must name both planners before the run, not after: ${plan.stdout}`);
    const planners = [...plan.stdout.matchAll(/planner-\d=([a-z-]+)\//g)].map((match) => match[1]);
    assert.equal(planners.length, 2, `expected two planners in the plan, got: ${plan.stdout}`);
    assert.notEqual(planners[0], planners[1], "a second approach from the same provider is not a second approach");

    // JSON, because the receipt is the evidence: which providers actually spent a call, taken
    // from the run itself rather than from a second command reading a shared history.
    const run = cli.run(["dogfood", "ask", "run", "--task", task, "--execute", "--json"]);
    // Exit 1 is a real outcome here, not a failure: a T4 reviewer that asks for changes ends the
    // task at "completed but needs your eyes". What must not happen is a crash or no receipt.
    assert.ok(run.status === 0 || run.status === 1, `run failed: ${run.stdout}${run.stderr}`);

    const receipt = JSON.parse(run.stdout) as {
      readonly outcome: string | null;
      readonly answer: string | null;
      readonly usage: readonly { readonly provider: string; readonly model: string | null; readonly metric: string }[];
    };
    assert.ok(receipt.outcome !== null, `no outcome in the receipt: ${run.stdout.slice(0, 500)}`);
    assert.ok((receipt.answer ?? "").length > 0, "the task produced no answer");

    const spenders = new Set(receipt.usage.filter((row) => row.metric === "provider_call").map((row) => row.provider));
    assert.ok(
      spenders.size >= 2,
      `expected more than one subscription to have spent a call, saw: ${[...spenders].join(", ") || "none"}`,
    );
  } finally {
    cli.cleanup();
  }
});

/**
 * Streaming, proven by when the text arrives rather than by what it says.
 *
 * A run that hands over its answer at the end and a run that writes it as it goes produce the
 * same string. The only difference a terminal cares about is timing, so that is what this
 * asserts: prose reached the callback while the provider was still running.
 */
test("a streamed provider writes its answer while it is still working", { skip: SKIP }, async () => {
  const { ProviderDiscovery } = await import("@braingate/providers");
  const { NodeShadowProcessExecutor, SubscriptionShadowAgentInvoker, GrokIsolationVerifier, streamDialectFor } = await import("@braingate/shadow");
  const { ProjectRegistry } = await import("@braingate/core");

  const cli = makeCli();
  try {
    register(cli);
    const registry = new ProjectRegistry(cli.home);
    const project = registry.loadFile(join(cli.repo, ".brain", "project.json"));
    const snapshots = await new ProviderDiscovery().discoverAll();
    const catalogue = JSON.parse(readFileSync(join(cli.home, "global", "models.json"), "utf8")) as {
      entries: readonly { readonly definition: { readonly providerId: string; readonly modelId: string; readonly quotaPool: string; readonly capabilities: Record<string, number> } }[];
    };

    const streamed: string[] = [];
    let finished = false;
    let sawTextBeforeTheEnd = false;
    let proven = 0;

    for (const providerId of ["anthropic", "xai"] as const) {
      assert.notEqual(streamDialectFor(providerId), null, `${providerId} must have a measured stream shape`);
      const snapshot = snapshots.find((item) => item.providerId === providerId);
      if (snapshot?.available.value !== true || snapshot.authState.value === "unauthenticated") continue;
      const entry = catalogue.entries
        .map((item) => item.definition)
        .filter((definition) => definition.providerId === providerId && typeof definition.capabilities.planner === "number")
        .sort((a, b) => (a.capabilities.planner ?? 0) - (b.capabilities.planner ?? 0))[0];
      if (entry === undefined) continue;

      // The temp directory is granted by every Grok profile, so the checkout-reachability check
      // is not the thing under test here.
      const grokIsolation = providerId === "xai" ? await new GrokIsolationVerifier().verify(snapshot) : undefined;
      finished = false;
      const invoker: InstanceType<typeof SubscriptionShadowAgentInvoker> = new SubscriptionShadowAgentInvoker({
        project, cwd: cli.repo, snapshots: [snapshot],
        ...(grokIsolation === undefined ? {} : { grokIsolation }),
        context: { note: "The reviewed change renames a label and touches nothing else." },
        executor: new NodeShadowProcessExecutor(),
        maxTurns: 6,
        onText: (text) => {
          streamed.push(text);
          if (!finished && text.trim().length > 0) sawTextBeforeTheEnd = true;
        },
      });

      // A planner, because only a contract with a prose field has prose to stream: a review
      // answers with a verdict and a list, and there is nothing there to write out live.
      const response: Awaited<ReturnType<typeof invoker.invoke>> = await invoker.invoke({
        role: "planner",
        model: { providerId, modelId: entry.modelId, quotaPool: entry.quotaPool },
        phase: "integration",
        task: "In two or three sentences, describe how you would rename a label in a small service without breaking callers.",
        findings: [],
        candidateOutput: null,
      });
      finished = true;
      assert.equal(response.kind, "work", `${providerId} answered as the wrong role`);
      proven += 1;
    }

    assert.ok(proven > 0, "neither streamed provider was installed and authenticated, so nothing was proven");
    assert.ok(sawTextBeforeTheEnd, "no prose arrived before the run ended, so nothing actually streamed");
    // What reached the terminal is readable text, not the JSON the contract is carried in.
    const joined = streamed.join("");
    assert.ok(joined.trim().length > 0, "the stream produced no readable text");
    assert.doesNotMatch(joined, /"kind"\s*:/, "the contract's JSON reached the terminal instead of the prose inside it");
  } finally {
    cli.cleanup();
  }
});
