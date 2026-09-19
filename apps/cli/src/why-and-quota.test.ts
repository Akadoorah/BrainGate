import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { initializeDogfoodProject } from "@braingate/dogfood";
import { GlobalQuotaStore } from "@braingate/observability";
import { ModelCatalog, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "@braingate/shadow";
import type { WriteProviderExecutor, WriteProviderPlan, WriteProviderResult } from "@braingate/write";
import { refusalLine, runRepl, whyLines } from "./repl.js";

/**
 * Phase D: the route explains itself, and quota state is visible.
 *
 * `/why` has to answer from the plan the operator was just shown (before anything runs), from the
 * ledger once a task exists (read or write — the write runner records no brief before this phase),
 * and from a past task's own record. An active refusal backoff has to be visible in the plan line
 * and in `/worker`, in BrainGate's own words rather than a provider's (ADR 0012). And a refusal the
 * REPL prints has to be one line, with the full text still reachable structurally.
 *
 * Every runtime here is a fake that answers in its own CLI's envelope, so no subscription is spent.
 */

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}

function snapshot(providerId: "anthropic" | "xai", displayName: string, binary: string): ProviderSnapshot {
  const observedAt = "2026-09-19T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId,
    displayName,
    binary,
    available: obs(true),
    version: obs("2.1.278"),
    authState: obs("authenticated"),
    authMode: obs("subscription"),
    models: obs(providerId === "anthropic" ? ["claude-sonnet-5"] : ["grok-4.6"]),
    capabilities: obs({ headless: true, modelPinning: true, sessionIdPinning: true, outputFormats: ["json"], supportsMcp: true, supportsSubagents: true }),
    quotaState: obs("unknown"),
    quotaHint: obs(null),
    quotaObservedAt: obs(null),
    refusalBackoffUntil: obs(null),
    observedAt,
  } as unknown as ProviderSnapshot;
}

/** A workspace with a README, and a catalogue scored on one or two subscriptions. */
function fixture(
  label: string,
  models: readonly { readonly providerId: "anthropic" | "xai"; readonly modelId: string; readonly quotaPool: string; readonly coder: number; readonly writeCapable?: boolean }[],
) {
  const root = mkdtempSync(join(tmpdir(), `braingate-why-${label}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# Sample\n\nA placeholder project.\n");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  initializeDogfoodProject({ cwd: repo, projectId: label, name: label });
  const home = join(root, "brain-home");
  const env = { BRAINGATE_HOME: home };
  const catalog = new ModelCatalog(resolveOperatorState(env, repo).modelCatalogPath);
  for (const model of models) {
    catalog.upsert({
      providerId: model.providerId,
      modelId: model.modelId,
      quotaPool: model.quotaPool,
      capabilities: { coder: model.coder, reviewer: 70, judge: 65 },
      speed: "balanced",
      contextCapacity: 200_000,
      writeCapable: model.writeCapable ?? false,
      reasoning: model.coder,
      underlyingFamily: null,
    });
  }
  return { root, repo, env, home };
}

/** Reads, in each provider's own envelope: Claude's `{result}`, Grok's `{text}`. */
class FakeReaders {
  readonly calls: { readonly providerId: string; readonly task: string }[] = [];
  readonly shadow: ShadowProcessExecutor = {
    run: async (input: { readonly plan: ShadowInvocationPlan }): Promise<ShadowProcessResult> => {
      const plan = input.plan;
      const body = plan.stdin ?? "";
      const parsed = JSON.parse(body) as { readonly task?: string };
      this.calls.push({ providerId: plan.providerId, task: parsed.task ?? "" });
      const contract = JSON.stringify({ kind: "work", output: `read by ${plan.providerId}: ${parsed.task ?? ""}`.slice(0, 80) });
      const base = { spawned: true, timedOut: false, durationMs: 5, stderr: "", removedEnvironmentKeys: Object.freeze([]) };
      if (plan.providerId === "xai") return { ...base, exitCode: 0, stdout: JSON.stringify({ text: contract }) };
      return { ...base, exitCode: 0, stdout: JSON.stringify({ result: contract }) };
    },
  };
}

/** A write worker that appends one line to the README, in Claude's envelope. */
class FakeWriter {
  readonly calls: { readonly providerId: string }[] = [];
  readonly writer: WriteProviderExecutor = {
    run: async (input: { readonly plan: WriteProviderPlan }): Promise<WriteProviderResult> => {
      const plan = input.plan;
      this.calls.push({ providerId: plan.providerId });
      const target = join(plan.cwd, "README.md");
      writeFileSync(target, `${readFileSync(target, "utf8")}\nA short line about the theme configuration.\n`);
      return {
        spawned: true, exitCode: 0, timedOut: false, durationMs: 5, stderr: "", removedEnvironmentKeys: Object.freeze([]),
        stdout: JSON.stringify({ result: JSON.stringify({ summary: "documented the theme configuration" }) }),
      };
    },
  };
}

/**
 * Drives a session from a script whose later steps may read what has been printed so far, which is
 * what makes "ask /why about a task id nobody scripted in advance" expressible: the id is minted by
 * the run itself, and a plain string script cannot name it ahead of time.
 */
function dynamicSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  reader: ShadowProcessExecutor,
  writer: WriteProviderExecutor | undefined,
  steps: readonly (string | ((textSoFar: string) => string))[],
  snapshots: readonly ProviderSnapshot[],
) {
  const remaining = [...steps];
  let out = "";
  let err = "";
  return {
    text: () => `${out}${err}`,
    run: () => runRepl({
      cwd,
      env,
      animate: false,
      colour: false,
      stdout: (t) => { out += t; },
      stderr: (t) => { err += t; },
      ask: async () => {
        const next = remaining.shift();
        if (next === undefined) return null;
        return typeof next === "function" ? next(`${out}${err}`) : next;
      },
      executor: reader,
      ...(writer === undefined ? {} : { writeExecutor: writer }),
      discoverAll: async () => snapshots,
      probeCapabilities: async () => ({ features: { sessionIdPinning: { supported: true } } }),
      measureCapabilities: async () => ({}),
      verifyGrokIsolation: async (item: ProviderSnapshot) => ({
        providerId: "xai" as const, source: "sandbox-event-self-test" as const,
        version: item.version.value ?? "0.0.0", platform: process.platform === "linux" ? "linux" as const : "darwin" as const,
        profileHash: "test-profile", policyHash: "test-policy",
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        readableRoots: [], networkRestricted: true, configSurfaces: [],
      }),
    }),
  };
}

test("/why answers from the plan before a run, naming the winner's own reasons and every rejection", async () => {
  const f = fixture("plan-only", [
    { providerId: "anthropic", modelId: "claude-sonnet-5", quotaPool: "claude-subscription", coder: 95 },
    { providerId: "xai", modelId: "grok-4.6", quotaPool: "grok-subscription", coder: 90 },
  ]);
  // BrainGate is resting the Anthropic pool after a refusal, so the automatic route has to go to
  // Grok instead — and the plan has to say both things: who won, and who was set aside and why.
  const quota = new GlobalQuotaStore(resolveOperatorState(f.env, f.repo).globalDir);
  quota.recordRefusalBackoff({ provider: "anthropic", quotaPool: "claude-subscription", reason: "rate_limit" });
  quota.close();

  const session = dynamicSession(
    f.repo, f.env, new FakeReaders().shadow, undefined,
    ["Summarize the project state in one line.", "n", "/why", "/worker", "/exit"],
    [snapshot("anthropic", "Claude Code", "claude"), snapshot("xai", "Grok Build", "grok")],
  );
  assert.equal(await session.run(), 0, session.text());
  const text = session.text();

  // The plan line itself says a pool is being avoided, in BrainGate's own words — never a provider
  // limit, a quota reading or a reset time (ADR 0012).
  assert.match(text, /BrainGate is resting claude-subscription until \d{2}:\d{2} after a refusal; it was not counted as a limit\./);

  // Nothing ran yet (the plan was declined), and `/why` still answers from the plan the operator
  // was shown: the winner's own reasons, and the loser's, by name.
  assert.match(text, /Route for the last plan \(not yet run\):/);
  assert.match(text, /primary: xai\/grok-4\.6 — /);
  assert.match(text, /rejected anthropic\/claude-sonnet-5: quota-pool-backoff:claude-subscription/);

  // `/worker` shows the same backoff, so it is visible without a plan too.
  const afterWorker = text.slice(text.indexOf("policy:"));
  assert.match(afterWorker, /BrainGate is resting claude-subscription until \d{2}:\d{2} after a refusal/);
});

test("/why reads the ledger after a run, for a read and for a write, and answers for a past task by id prefix", async () => {
  const f = fixture("after-run", [{ providerId: "anthropic", modelId: "claude-sonnet-5", quotaPool: "claude-subscription", coder: 95, writeCapable: true }]);
  const reader = new FakeReaders();
  const writer = new FakeWriter();
  const session = dynamicSession(
    f.repo, f.env, reader.shadow, writer.writer,
    [
      "Summarize the project state in one line.", "y",
      "Add a short line about the theme configuration to the README.", "y",
      "/why",
      (textSoFar: string) => {
        const first = [...textSoFar.matchAll(/Task ([0-9a-f-]{36})/g)][0];
        assert.ok(first !== undefined, `expected a task id in:\n${textSoFar}`);
        return `/why ${first![1]!.slice(0, 8)}`;
      },
      "/exit",
    ],
    [snapshot("anthropic", "Claude Code", "claude")],
  );
  assert.equal(await session.run(), 0, session.text());
  const text = session.text();

  const taskIds = [...text.matchAll(/Task ([0-9a-f-]{36})/g)].map((m) => m[1]!);
  assert.equal(taskIds.length, 2, "one read task and one write task");
  const [readTaskId, writeTaskId] = taskIds as [string, string];

  // The bare `/why` answers for the most recent task — the write — and the write runner now
  // records the same brief the read runner always has (the gap this phase closes).
  assert.match(text, new RegExp(`Route for task ${writeTaskId}:\\n\\s+primary: anthropic/claude-sonnet-5 — `));

  // `/why <prefix>` for the earlier, read task answers from the ledger rather than from what is
  // cached in the session — proving a *past* task's brief is readable, not only the latest one.
  assert.match(text, new RegExp(`Route for task ${readTaskId}:\\n\\s+primary: anthropic/claude-sonnet-5 — `));

  // Both routes reached the ledger through `task.brief`, and `whyLines`/`refusalLine` are the
  // reusable pieces this test exercises directly, so a shape they stop handling fails loudly here
  // rather than only in the terminal.
  assert.deepEqual(whyLines([]), []);
  assert.equal(refusalLine({ notAnError: true }), null);
});

test("a refusal the REPL prints is one line, and the full text is still in the error object", async () => {
  // `refusalLine` is the mechanism Phase D adds: a code that has been given a one-liner is
  // shortened, with the full message kept in the data it was given; a code the table does not know
  // falls back to that full message unshortened. Both are asserted directly, which is the hermetic
  // half of "the one-line refusal with the full text under --json" — the flag interface's own
  // `--json` rendering of the same `{ error, recorded }` shape is unchanged and covered where the
  // codes themselves are thrown (`packages/router/src/automatic-routing.test.ts`,
  // `packages/shadow/src/native-direct.test.ts`, `apps/cli/src/dogfood-cli.test.ts`).
  const known = refusalLine({ error: { code: "WRITE_REVIEWER_UNAVAILABLE", message: "This is a T3 change, so it is reviewed by a model from a provider other than anthropic — and none is eligible here. anthropic is the only signed-in provider on this machine. Sign in to a second CLI, or score one of its models for the reviewer role with /models. Nothing was spent." }, recorded: false });
  assert.equal(known, "BrainGate WRITE_REVIEWER_UNAVAILABLE: No independent reviewer is available for this write. Next: sign in to a second CLI, or score one of its models for review with /models.\n\nNo task was created. Nothing was recorded for this attempt.");

  const unknownCode = "SOME_FUTURE_CODE_NOBODY_HAS_MAPPED_YET";
  const fullMessage = "A brand new refusal this table has never seen, several sentences long, with a measurement nobody has shortened yet.";
  const fallback = refusalLine({ error: { code: unknownCode, message: fullMessage }, recorded: true });
  assert.equal(fallback, `BrainGate ${unknownCode}: ${fullMessage}`, "an unmapped code falls back to its own full message, unshortened");

  // A shape that is not the `{ error, recorded }` object dogfood-cli.ts produces yields nothing to
  // print, so a caller falls back to whatever text it already captured rather than printing "null".
  assert.equal(refusalLine(null), null);
  assert.equal(refusalLine("plain string"), null);
});
