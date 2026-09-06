import test from "node:test";
import assert from "node:assert/strict";
import type { ProbeCommand, ProbeResult, ProbeRunner } from "./types.js";
import { ProviderDiscovery, formatProbeCommand } from "./index.js";

function result(
  command: ProbeCommand,
  values: Partial<Omit<ProbeResult, "command" | "observedAt" | "removedBillingOverrides">> = {},
): ProbeResult {
  return {
    command,
    spawned: values.spawned ?? true,
    exitCode: values.exitCode ?? 0,
    stdout: values.stdout ?? "",
    stderr: values.stderr ?? "",
    timedOut: values.timedOut ?? false,
    errorCode: values.errorCode ?? null,
    observedAt: "2026-09-07T00:00:00.000Z",
    removedBillingOverrides: Object.freeze(["OPENAI_API_KEY"]),
  };
}

class FakeRunner implements ProbeRunner {
  readonly calls: ProbeCommand[] = [];
  readonly #responses: ReadonlyMap<string, Partial<Omit<ProbeResult, "command" | "observedAt" | "removedBillingOverrides">>>;

  constructor(entries: readonly [string, Partial<Omit<ProbeResult, "command" | "observedAt" | "removedBillingOverrides">>][] = []) {
    this.#responses = new Map(entries);
  }

  async run(command: ProbeCommand): Promise<ProbeResult> {
    this.calls.push(command);
    const configured = this.#responses.get(formatProbeCommand(command));
    return result(command, configured);
  }
}

test("missing binary returns unavailable and does not try follow-up probes", async () => {
  const runner = new FakeRunner([
    ["claude --version", { spawned: false, exitCode: null, errorCode: "ENOENT" }],
  ]);
  const snapshot = await new ProviderDiscovery(runner).discover("anthropic");

  assert.equal(snapshot.available.value, false);
  assert.equal(snapshot.authState.value, "unknown");
  assert.equal(snapshot.models.value, null);
  assert.equal(runner.calls.length, 1);
});

test("Claude auth status proves subscription OAuth without a model call", async () => {
  const runner = new FakeRunner([
    ["claude --version", { stdout: "2.1.248 (Claude Code)\n" }],
    ["claude --help", { stdout: "claude -p --model MODEL --output-format json mcp\n" }],
    ["claude auth status", { stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\n' }],
  ]);
  const snapshot = await new ProviderDiscovery(runner).discover("anthropic");
  assert.equal(snapshot.authState.value, "authenticated");
  assert.equal(snapshot.authMode.value, "subscription");
  assert.equal(snapshot.authState.evidence, "native");
  assert.deepEqual(runner.calls.map(formatProbeCommand), ["claude --version", "claude --help", "claude auth status"]);
  assert.ok(runner.calls.every((command) => !command.args.includes("-p") && !command.args.includes("--prompt")));
});

test("Claude console/API authentication is never mislabeled as subscription", async () => {
  const runner = new FakeRunner([
    ["claude --version", { stdout: "2.1.248\n" }],
    ["claude --help", { stdout: "claude -p --model MODEL --output-format json\n" }],
    ["claude auth status", { stdout: '{"loggedIn":true,"authMethod":"console","subscriptionType":null}\n' }],
  ]);
  const snapshot = await new ProviderDiscovery(runner).discover("anthropic");
  assert.equal(snapshot.authState.value, "authenticated");
  assert.equal(snapshot.authMode.value, "api");
});

test("Antigravity model discovery preserves provider-owned model slugs without prompting", async () => {
  const runner = new FakeRunner([
    ["agy --version", { stdout: "agy 2.8.0\n" }],
    ["agy --help", { stdout: "Usage: agy -p --model MODEL --output-format json mcp\n" }],
    [
      "agy models",
      {
        stdout:
          "gemini-3.8-flash-high     Gemini 3.8 Flash (High)\nclaude-sonnet-4-6         Claude Sonnet 4.6\ncustom/model.v2           Custom Model\n",
      },
    ],
  ]);
  const snapshot = await new ProviderDiscovery(runner).discover("google");

  assert.deepEqual(snapshot.models.value, ["gemini-3.8-flash-high", "claude-sonnet-4-6", "custom/model.v2"]);
  assert.equal(snapshot.models.evidence, "native");
  assert.equal(snapshot.authState.value, "unknown");
  assert.equal(snapshot.capabilities.value.modelPinning, true);
  assert.equal(snapshot.capabilities.value.mcp, true);
  assert.ok(runner.calls.every((command) => !command.args.includes("-p") && !command.args.includes("--prompt")));
});

test("model metadata timeout stays unknown rather than guessing auth or models", async () => {
  const runner = new FakeRunner([
    ["grok version", { stdout: "grok 1.4.0\n" }],
    ["grok --help", { stdout: "grok -p --output-format json -m MODEL mcp\n" }],
    ["grok models", { exitCode: null, timedOut: true, errorCode: null }],
  ]);
  const snapshot = await new ProviderDiscovery(runner).discover("xai");

  assert.equal(snapshot.available.value, true);
  assert.equal(snapshot.models.value, null);
  assert.equal(snapshot.models.evidence, "unknown");
  assert.equal(snapshot.authState.value, "unknown");
  assert.match(snapshot.warnings.join(" "), /unknown|did not complete/i);
});

test("providers without verified zero-prompt auth/status commands report unknown instead of making a model call", async () => {
  const runner = new FakeRunner([
    ["copilot version", { stdout: "GitHub Copilot CLI 0.9.0\n" }],
    ["copilot help", { stdout: "Options: -p --prompt --model --output-format json --stream; Commands: mcp\n" }],
  ]);
  const snapshot = await new ProviderDiscovery(runner).discover("github-copilot");

  assert.equal(snapshot.models.value, null);
  assert.equal(snapshot.usage.value, null);
  assert.equal(snapshot.authMode.value, "unknown");
  assert.deepEqual(runner.calls.map(formatProbeCommand), ["copilot version", "copilot help"]);
});

test("discoverAll only issues commands from the safe metadata probe set", async () => {
  const runner = new FakeRunner();
  const snapshots = await new ProviderDiscovery(runner).discoverAll();

  assert.equal(snapshots.length, 5);
  for (const call of runner.calls) {
    const command = formatProbeCommand(call);
    assert.doesNotMatch(command, /\s-p\s|--prompt|\bexec\b|\blogin\b|\bupdate\b|\binit\b/);
  }
});
