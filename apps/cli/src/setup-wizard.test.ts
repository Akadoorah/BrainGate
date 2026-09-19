import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ModelCatalog, ProviderAcceptanceStore, resolveOperatorState } from "@braingate/operator";
import type { ProviderSnapshot } from "@braingate/providers";
import { runSetupWizard } from "./setup-wizard.js";
import { runDogfoodCli } from "./dogfood-cli.js";
import { attachFromManifest } from "./project-attachment.js";
import { readSessionPreferences, sessionPreferencesPath } from "./session-preferences.js";

/**
 * The first ten minutes, driven from a script.
 *
 * Everything here is hermetic: an isolated `BRAINGATE_HOME`, a fake HOME whose Antigravity
 * settings file is watched for modification, and discovery supplied rather than measured. The
 * operator's own catalogue, acceptances and settings are never on the path this exercises — which
 * is not a testing convenience but the property under test (`memory/operator-owns-provider-decisions`).
 */

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
}

interface Fixture {
  readonly repo: string;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly fakeHome: string;
  readonly settingsPath: string;
}

/**
 * A throwaway repository, an operator state directory of its own, and a fake HOME.
 *
 * The fake HOME carries an Antigravity settings file with no rules in it, which is both the
 * interesting case for the hint and the file this test asserts nothing ever writes to.
 */
function fixture(label: string, settings: string | null = JSON.stringify({ permissions: { allow: [] } })): Fixture {
  const root = mkdtempSync(join(tmpdir(), `braingate-wizard-${label}-`));
  const repo = join(root, label);
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "BrainGate Test"]);
  writeFileSync(join(repo, "README.md"), "# test\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  const home = join(root, "brain-home");
  const fakeHome = join(root, "fake-home");
  const settingsPath = join(fakeHome, ".gemini", "antigravity-cli", "settings.json");
  if (settings !== null) {
    mkdirSync(join(settingsPath, ".."), { recursive: true });
    writeFileSync(settingsPath, settings);
  }
  return { repo, env: { BRAINGATE_HOME: home, HOME: fakeHome }, home, fakeHome, settingsPath };
}

function snapshot(providerId: string, binary: string, models: readonly string[] | null, options: { readonly available?: boolean; readonly authState?: string } = {}): ProviderSnapshot {
  const observedAt = "2026-09-19T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId, displayName: providerId, binary,
    available: obs(options.available ?? true),
    version: obs("1.0.0"),
    authState: obs(options.authState ?? "authenticated"),
    authMode: obs("subscription"),
    models: obs(models === null ? null : [...models]),
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: obs(null),
    removedBillingOverrides: Object.freeze([]),
    warnings: Object.freeze([]),
  } as unknown as ProviderSnapshot;
}

/** The four CLIs as they answered on 2026-09-19, with Codex signed out. */
const INSTALLED = [
  snapshot("anthropic", "claude", null),
  snapshot("openai", "codex", null, { authState: "unauthenticated" }),
  snapshot("google", "agy", ["gemini-3.8-flash-medium", "gemini-3.1-pro-high", "claude-sonnet-4-6"]),
  snapshot("xai", "grok", ["grok-4.6", "grok-4.5"]),
];

function driver(f: Fixture, answers: readonly string[], snapshots: readonly ProviderSnapshot[] = INSTALLED) {
  const remaining = [...answers];
  const asked: string[] = [];
  let out = "";
  return {
    asked,
    text: () => out,
    run: () => runSetupWizard({
      cwd: f.repo,
      env: f.env,
      stdout: (text) => { out += text; },
      stderr: (text) => { out += text; },
      ask: async (question) => { asked.push(question); return remaining.shift() ?? null; },
      discoverAll: async () => snapshots,
    }),
  };
}

/** The settings file's modification time, to the nanosecond, or null when there is none. */
function mtime(path: string): string | null {
  try { return String(statSync(path, { bigint: true }).mtimeNs); } catch { return null; }
}

test("four answers register the project, score the catalogue and record the acceptance", async () => {
  const f = fixture("full");
  const before = mtime(f.settingsPath);
  const d = driver(f, ["y", "y", "y", "n"]);
  const result = await d.run();

  assert.equal(result.exitCode, 0, d.text());
  assert.equal(result.registered, true);
  assert.equal(result.projectId, "full");
  assert.equal(result.reviewAlways, false);

  // At most four questions, and each one in the plan's words.
  assert.equal(d.asked.length, 4, `asked: ${JSON.stringify(d.asked)}`);
  assert.match(d.asked[0]!, /Register .* as a BrainGate project\? \[Y\/n\]/);
  assert.match(d.asked[1]!, /Adopt these \d+ models with these starting scores\? \[Y\/n\]/);
  assert.match(d.asked[2]!, /Accept Antigravity as an unscoped provider for 30 days\? \[y\/N\]/);
  assert.match(d.asked[3]!, /Require a reviewer on every write in this session\? \[y\/N\]/);

  // The catalogue: listed ids adopted, unlisted ids assumed, and the Antigravity-served Claude
  // model imported unscored rather than filed under the Claude subscription.
  const entries = new ModelCatalog(resolveOperatorState(f.env).modelCatalogPath).load();
  const configured = entries.filter((entry) => entry.configured);
  assert.ok(configured.some((entry) => entry.providerId === "xai" && entry.modelId === "grok-4.6"));
  assert.ok(configured.some((entry) => entry.providerId === "anthropic" && entry.modelId === "claude-sonnet-5"));
  const served = entries.find((entry) => entry.providerId === "google" && entry.modelId === "claude-sonnet-4-6");
  assert.equal(served?.configured, false, "an Antigravity-served Claude model was scored as if it were the Claude subscription");
  const grok = configured.find((entry) => entry.modelId === "grok-4.6")!;
  assert.equal(grok.configured ? grok.source : null, "braingate-default");
  const sonnet = configured.find((entry) => entry.modelId === "claude-sonnet-5")!;
  assert.equal(sonnet.configured ? sonnet.source : null, "braingate-assumed");
  assert.match(d.text(), /assumed: claude lists no models/);

  // The acceptance record says what it is, in the store the operator can read.
  const record = new ProviderAcceptanceStore(resolveOperatorState(f.env).providerAcceptancePath).find("google");
  assert.notEqual(record, null);
  assert.equal(record!.source, "operator-accepted-unscoped-provider");
  assert.deepEqual(result.accepted, ["google"]);

  // The Antigravity hint is printed, and the operator's settings file is not touched by any of it.
  assert.match(d.text(), /read_file\(\*\)/);
  assert.match(d.text(), /command\(\*\)/);
  assert.match(d.text(), /BrainGate never edits that file/);
  assert.ok(d.text().includes(f.settingsPath), "the hint must name the file the operator has to edit");
  assert.equal(mtime(f.settingsPath), before, "the wizard wrote to another CLI's settings");

  // The closing lines: what was assumed, and where each of it is changed.
  assert.match(d.text(), /policy `direct`/);
  assert.match(d.text(), /big writes .* isolated worktree with a reviewer/);
  assert.match(d.text(), /quota is read from each CLI's own reporting/);
  assert.match(d.text(), /independent review: cross-provider/);
  assert.match(d.text(), /Editable any time: \/setup, \/models, \/providers, \/policy, \/review\./);
});

test("declining registration leaves nothing behind and says how to start", async () => {
  const f = fixture("declined");
  const d = driver(f, ["n"]);
  const result = await d.run();
  assert.equal(result.registered, false);
  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(join(f.repo, ".brain", "project.json")), false);
  assert.match(d.text(), /Nothing registered\. Run `braingate init` here when you are ready\./);
  assert.equal(d.asked.length, 1, "nothing else may be asked once registration is declined");
});

test("no CLI installed still registers, adopts nothing, spends nothing and exits 0", async () => {
  const f = fixture("no-cli");
  const d = driver(f, ["y", "n"], [
    snapshot("anthropic", "claude", null, { available: false }),
    snapshot("openai", "codex", null, { available: false }),
    snapshot("google", "agy", null, { available: false }),
    snapshot("xai", "grok", null, { available: false }),
  ]);
  const result = await d.run();
  assert.equal(result.exitCode, 0, d.text());
  assert.equal(result.registered, true);
  assert.deepEqual(result.adopted, []);
  assert.deepEqual(result.assumed, []);
  assert.match(d.text(), /No provider CLI is installed on this machine/);
  // Registration and the review question, and nothing about adopting or accepting.
  assert.equal(d.asked.length, 2, `asked: ${JSON.stringify(d.asked)}`);
  assert.equal(new ModelCatalog(resolveOperatorState(f.env).modelCatalogPath).load().length, 0);
});

test("an installed CLI that is signed out is named, with the command that fixes it", async () => {
  const f = fixture("signed-out");
  const d = driver(f, ["y", "y", "n", "n"]);
  await d.run();
  assert.match(d.text(), /openai \(codex\) is installed and not signed in/);
  assert.match(d.text(), /codex login/);
});

test("a rerun keeps the operator's scores and reports them as kept", async () => {
  const f = fixture("rerun");
  await driver(f, ["y", "y", "n", "n"]).run();

  // The operator re-scores one model by hand, the way `models add` does.
  const catalog = new ModelCatalog(resolveOperatorState(f.env).modelCatalogPath);
  catalog.upsert({
    providerId: "xai", modelId: "grok-4.6", quotaPool: "grok-subscription",
    capabilities: { coder: 99 }, speed: "deep", contextCapacity: 256_000,
    writeCapable: true, reasoning: 99, underlyingFamily: null,
  });

  const again = driver(f, ["y", "n", "n"]);
  const result = await again.run();
  assert.equal(result.exitCode, 0, again.text());
  assert.match(again.text(), /already registered here\. Nothing about it is changed\./);
  assert.ok(result.kept.includes("xai/grok-4.6"), `kept: ${JSON.stringify(result.kept)}`);
  const entry = catalog.load().find((row) => row.modelId === "grok-4.6")!;
  assert.equal(entry.configured ? entry.definition.capabilities.coder : null, 99, "a rerun overwrote the operator's score");
  assert.equal(entry.configured ? entry.source : "absent", undefined, "a rerun relabelled the operator's entry");
});

test("the review answer is remembered for this workspace", async () => {
  const f = fixture("review");
  const result = await driver(f, ["y", "y", "n", "y"]).run();
  assert.equal(result.reviewAlways, true);
  const manifest = JSON.parse(readFileSync(join(f.repo, ".brain", "project.json"), "utf8")) as { readonly project_id: string };
  assert.equal(manifest.project_id, "review");
  const storage = join(resolveOperatorState(f.env).home, "projects", manifest.project_id);
  // The preference is written beside the workspace's own execution state, never into the manifest.
  assert.equal(readFileSync(join(f.repo, ".brain", "project.json"), "utf8").includes("reviewAlways"), false);
  assert.ok(existsSync(storage), "the project's storage directory should exist");
});

test("`init --adopt-models --accept google` does the wizard's work without asking anything", async () => {
  const f = fixture("flags");
  let out = "";
  const result = await runDogfoodCli(["init", "--adopt-models", "--accept", "google"], {
    cwd: f.repo,
    env: f.env,
    stdout: (text) => { out += text; },
    stderr: (text) => { out += text; },
    // No `ask`: nothing may prompt on this path, and a question would hang rather than default.
    discoverAll: async () => INSTALLED,
  });
  assert.equal(result.exitCode, 0, out);
  const entries = new ModelCatalog(resolveOperatorState(f.env).modelCatalogPath).load();
  assert.ok(entries.some((entry) => entry.configured && entry.modelId === "grok-4.6"));
  assert.ok(entries.some((entry) => entry.configured && entry.modelId === "claude-sonnet-5"));
  assert.notEqual(new ProviderAcceptanceStore(resolveOperatorState(f.env).providerAcceptancePath).find("google"), null);
  assert.equal(existsSync(join(f.repo, ".brain", "project.json")), true);
});

test("`init` with flags stays non-interactive and never runs the wizard", async () => {
  const f = fixture("plain");
  const asked: string[] = [];
  let out = "";
  const result = await runDogfoodCli(["init", "--project-id", "plain-id", "--name", "Plain"], {
    cwd: f.repo,
    env: f.env,
    stdout: (text) => { out += text; },
    stderr: (text) => { out += text; },
    ask: async (question) => { asked.push(question); return "y"; },
    discoverAll: async () => INSTALLED,
  });
  assert.equal(result.exitCode, 0, out);
  assert.deepEqual(asked, [], "a flagged init asked a question");
  assert.equal(JSON.parse(readFileSync(join(f.repo, ".brain", "project.json"), "utf8")).project_id, "plain-id");
  // Nothing was adopted and nothing was accepted: stating an intent is not consenting to the rest.
  assert.equal(new ModelCatalog(resolveOperatorState(f.env).modelCatalogPath).load().length, 0);
  assert.equal(new ProviderAcceptanceStore(resolveOperatorState(f.env).providerAcceptancePath).find("google"), null);
});

test("an environment that names no HOME reads no other CLI's settings at all", async () => {
  // The settings reader falls back to the process's own home only when the environment names
  // none, so a wizard given an environment without HOME must report "nothing allowed" rather than
  // reach the operator's real rules. The hint is therefore printed, and nothing is read.
  const f = fixture("no-home", null);
  let out = "";
  const result = await runSetupWizard({
    cwd: f.repo,
    env: { BRAINGATE_HOME: f.home },
    stdout: (text) => { out += text; },
    stderr: (text) => { out += text; },
    ask: async () => "y",
    discoverAll: async () => INSTALLED,
  });
  assert.equal(result.exitCode, 0, out);
  assert.match(out, /BrainGate never edits that file/);
  assert.equal(existsSync(f.settingsPath), false, "no settings file may be created anywhere");
});

test("the preferences file is the workspace's own, and readable only by its owner", async () => {
  const f = fixture("prefs");
  await driver(f, ["y", "n", "n", "y"]).run();
  const attached = attachFromManifest(resolveOperatorState(f.env), ".brain/project.json", f.repo);
  const path = sessionPreferencesPath(attached.scope.storageDir);
  assert.equal(existsSync(path), true, "no preferences file was written");
  assert.equal(readSessionPreferences(path).reviewAlways, true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // Beside the thread, under this workspace's execution state — never in the shared manifest.
  assert.equal(path.startsWith(attached.scope.storageDir), true);
});
