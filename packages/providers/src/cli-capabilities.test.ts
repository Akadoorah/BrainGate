import test from "node:test";
import assert from "node:assert/strict";
import { CLI_FEATURES, cliCapabilityProbes, isCliFeature, probeCliCapabilities, readCliCapabilities } from "./cli-capabilities.js";
import { assertSafeProbeCommand } from "./probe-runner.js";
import { PROVIDER_IDS } from "./types.js";
import type { ProbeCommand, ProbeResult, ProbeRunner } from "./types.js";

function probe(command: ProbeCommand, overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    command,
    spawned: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    errorCode: null,
    observedAt: "2026-09-09T00:00:00.000Z",
    removedBillingOverrides: [],
    ...overrides,
  };
}

class StubRunner implements ProbeRunner {
  readonly seen: ProbeCommand[] = [];
  constructor(private readonly reply: (command: ProbeCommand) => ProbeResult) {}
  async run(command: ProbeCommand): Promise<ProbeResult> {
    this.seen.push(command);
    return this.reply(command);
  }
}

test("a flag present in help is reported with the text that proved it", () => {
  const report = readCliCapabilities({
    providerId: "xai",
    help: [probe({ binary: "grok", args: ["--help"] }, { stdout: "--json-schema <SCHEMA>\n--agents <JSON>\n--worktree" })],
    version: "1.0.24",
    observedAt: "2026-09-09T00:00:00.000Z",
  });
  assert.equal(report.features.structuredSchema.supported, true);
  assert.equal(report.features.structuredSchema.evidence, "--json-schema");
  assert.equal(report.features.declaredSubagents.supported, true);
  assert.equal(report.features.worktree.supported, true);
});

test("a flag absent from readable help is false, not unknown", () => {
  const report = readCliCapabilities({
    providerId: "xai",
    help: [probe({ binary: "grok", args: ["--help"] }, { stdout: "--model <MODEL>" })],
    version: "1.0.24",
    observedAt: "2026-09-09T00:00:00.000Z",
  });
  assert.equal(report.features.structuredSchema.supported, false);
  assert.equal(report.features.structuredSchema.evidence, null);
});

test("help that could not be read leaves every feature unknown rather than absent", () => {
  const report = readCliCapabilities({
    providerId: "google",
    help: [probe({ binary: "agy", args: ["--help"] }, { spawned: false, exitCode: null, errorCode: "ENOENT" })],
    version: null,
    observedAt: "2026-09-09T00:00:00.000Z",
  });
  for (const feature of CLI_FEATURES) {
    assert.equal(report.features[feature].supported, "unknown", feature);
  }
});

test("help printed on a non-zero exit still counts as a measurement", () => {
  const report = readCliCapabilities({
    providerId: "openai",
    help: [probe({ binary: "codex", args: ["exec", "--help"] }, { exitCode: 2, stderr: "--output-schema <FILE>" })],
    version: "0.153.4",
    observedAt: "2026-09-09T00:00:00.000Z",
  });
  assert.equal(report.features.structuredSchema.supported, true);
});

test("a feature living under a subcommand is found because both help texts are read", async () => {
  const runner = new StubRunner((command) =>
    probe(command, { stdout: command.args.includes("exec") ? "--output-schema <FILE>" : "--model <MODEL>" }),
  );
  const report = await probeCliCapabilities({ providerId: "openai", runner, version: "0.153.4", now: () => new Date("2026-09-09T00:00:00.000Z") });
  assert.equal(runner.seen.length, 2);
  assert.equal(report.features.structuredSchema.supported, true);
  assert.deepEqual(report.sourceCommands, ["codex --help", "codex exec --help"]);
});

test("every probe reads help only, so a report can never spend a model call", () => {
  const forbidden = ["-p", "--print", "--prompt", "--prompt-file", "--prompt-json", "-i", "--model", "exec"];
  for (const providerId of PROVIDER_IDS) {
    for (const command of cliCapabilityProbes(providerId)) {
      const args = command.args.filter((argument) => argument !== "exec");
      assert.ok(args.some((argument) => argument === "--help" || argument === "help"), `${providerId} probe must ask for help`);
      for (const argument of args) {
        assert.ok(!forbidden.includes(argument), `${providerId} probe must not pass ${argument}`);
      }
    }
  }
});

test("the feature list and its guard cannot drift apart", () => {
  for (const feature of CLI_FEATURES) assert.ok(isCliFeature(feature));
  assert.equal(isCliFeature("definitelyNotAFeature"), false);
});

test("the report is dated and names the build it measured", () => {
  const report = readCliCapabilities({
    providerId: "anthropic",
    help: [probe({ binary: "claude", args: ["--help"] }, { stdout: "--json-schema" })],
    version: "2.1.266",
    observedAt: "2026-09-09T12:00:00.000Z",
  });
  assert.equal(report.version, "2.1.266");
  assert.equal(report.observedAt, "2026-09-09T12:00:00.000Z");
});

test("every capability probe is already on the discovery safe-command allowlist", () => {
  for (const providerId of PROVIDER_IDS) {
    for (const command of cliCapabilityProbes(providerId)) assertSafeProbeCommand(command);
  }
});

test("every provider has a spec, so no provider silently reports nothing", () => {
  for (const providerId of PROVIDER_IDS) {
    assert.ok(cliCapabilityProbes(providerId).length > 0, providerId);
  }
});
