import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderId, ProviderSnapshot } from "@braingate/providers";
import { GROK_PROBE_MODEL, GROK_SANDBOX_PROFILE, GROK_STAGED_SANDBOX, GROK_WRITE_SANDBOX, GrokIsolationVerifier, grokConfigSurfaces, resolveGrokHome } from "./grok-isolation.js";
import type { CodexSandboxResult, CodexSandboxRunner } from "./codex-isolation.js";

function snapshot(values: { version?: string; available?: boolean } = {}): ProviderSnapshot {
  const observedAt = "2026-09-08T00:00:00.000Z";
  const obs = <T>(value: T) => ({ value, evidence: "native" as const, sourceCommand: null, observedAt });
  return {
    providerId: "xai" as ProviderId, displayName: "Grok Build", binary: "grok",
    available: obs(values.available ?? true), version: obs(values.version ?? "grok 1.0.13"),
    authState: obs("authenticated" as const), authMode: obs("subscription" as const),
    models: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    capabilities: obs({ headless: true, structuredOutput: true, modelPinning: true, mcp: true }),
    usage: { value: null, evidence: "unknown", sourceCommand: null, observedAt },
    removedBillingOverrides: [], warnings: [],
  };
}

/**
 * Stands in for the Grok CLI: it appends whatever sandbox event the case under test wants to
 * the event log, then reports the model error a probe run produces. That is the real sequence —
 * the profile is applied and logged before the requested model is validated — and it is what
 * makes the self-test cost nothing.
 */
class FakeGrok implements CodexSandboxRunner {
  readonly seen: string[][] = [];
  constructor(
    private readonly event: ((workspace: string) => unknown) | null,
    private readonly stderr = "",
    /** Where this build keeps its log. 1.0.24 moved it under `sessions/`. */
    private readonly logDirectory: "home" | "sessions" = "home",
  ) {}
  async run(input: { readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv }): Promise<CodexSandboxResult> {
    this.seen.push([...input.args]);
    const workspace = input.args[input.args.indexOf("--cwd") + 1]!;
    if (this.event !== null) {
      const directory = this.logDirectory === "home" ? input.env.GROK_HOME! : join(input.env.GROK_HOME!, "sessions");
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, "sandbox-events.jsonl"), `${JSON.stringify(this.event(workspace))}\n`);
    }
    return { spawned: true, exitCode: 1, stdout: "", stderr: this.stderr, timedOut: false };
  }
}

function grokHome(config = ""): string {
  const home = mkdtempSync(join(tmpdir(), "braingate-grok-home-"));
  if (config.length > 0) writeFileSync(join(home, "config.toml"), config, "utf8");
  writeFileSync(join(home, "sandbox-events.jsonl"), "", "utf8");
  return home;
}

function applied(profile = GROK_SANDBOX_PROFILE, extra: Record<string, unknown> = {}) {
  return (workspace: string) => ({
    event_type: "ProfileApplied", profile, workspace, enforced: true, restrict_network: true,
    read_only_paths: ["/usr", "/bin", workspace], read_write_paths: [workspace],
    ...extra,
  });
}

function verifier(home: string, runner: CodexSandboxRunner, platform: NodeJS.Platform = "darwin") {
  return new GrokIsolationVerifier({ runner, platform, env: { PATH: "/usr/bin", HOME: home, GROK_HOME: home } });
}

test("the self-test proves the sandbox from Grok's own record, and spends no tokens", async () => {
  const home = grokHome();
  const runner = new FakeGrok(applied());
  const attestation = await verifier(home, runner).verify(snapshot());

  assert.equal(attestation.providerId, "xai");
  assert.equal(attestation.source, "sandbox-event-self-test");
  // A model that cannot exist: the run aborts at model validation, after the kernel policy is
  // already applied and logged. That is the whole reason this is free.
  assert.ok(runner.seen[0]!.includes(GROK_PROBE_MODEL));
  assert.ok(runner.seen[0]!.includes("--sandbox"));
  // The probe's HOME is not the operator's, so another tool's settings file cannot be read.
  assert.notEqual(runner.seen.length, 0);
});

test("a run Grok refused to start is not an isolated run", async () => {
  const home = grokHome();
  // Grok aborts when a custom profile cannot be applied. Treating that as anything but a
  // failure would attest an isolation that was never in force.
  await assert.rejects(
    () => verifier(home, new FakeGrok(null, "error: Refusing to start with its protections missing.")).verify(snapshot()),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GROK_ISOLATION_SELF_TEST_FAILED",
  );
});

test("no recorded profile means no attestation, however the run ended", async () => {
  await assert.rejects(
    () => verifier(grokHome(), new FakeGrok(null)).verify(snapshot()),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GROK_ISOLATION_SELF_TEST_FAILED",
  );
});

test("a profile the operator's own sandbox.toml shadowed is caught by what it granted", async () => {
  const home = grokHome();
  // Grok resolves a user profile in preference to the project one, silently. A hash over the
  // file BrainGate wrote would still match; the paths actually enforced would not.
  const shadowed = applied(GROK_SANDBOX_PROFILE, { read_write_paths: ["/Users/someone"] });
  await assert.rejects(
    () => verifier(home, new FakeGrok(shadowed)).verify(snapshot()),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GROK_ISOLATION_SELF_TEST_FAILED",
  );
});

test("a sandbox that would still reach the registered project fails", async () => {
  const home = grokHome();
  const project = mkdtempSync(join(tmpdir(), "braingate-grok-project-"));
  const reaching = (workspace: string) => ({
    event_type: "ProfileApplied", profile: GROK_SANDBOX_PROFILE, workspace, enforced: true,
    read_only_paths: ["/usr", workspace, project], read_write_paths: [workspace],
  });
  await assert.rejects(
    () => verifier(home, new FakeGrok(reaching)).verify(snapshot(), { projectPaths: [project] }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GROK_ISOLATION_SELF_TEST_FAILED",
  );
});

test("an unenforced profile is reported as applied but is not isolation", async () => {
  const home = grokHome();
  await assert.rejects(
    () => verifier(home, new FakeGrok(applied(GROK_SANDBOX_PROFILE, { enforced: false }))).verify(snapshot()),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GROK_ISOLATION_SELF_TEST_FAILED",
  );
});

test("network restriction is recorded per platform, never claimed uniformly", async () => {
  const linux = await verifier(grokHome(), new FakeGrok(applied()), "linux").verify(snapshot());
  const darwin = await verifier(grokHome(), new FakeGrok(applied()), "darwin").verify(snapshot());
  assert.equal(linux.networkRestricted, true);
  // On macOS Grok reports the request and the kernel does not block child-process network.
  // An attestation that said otherwise would be a guarantee BrainGate cannot keep.
  assert.equal(darwin.networkRestricted, false);
});

test("Windows is refused rather than attested on a sandbox that does not exist there", async () => {
  await assert.rejects(
    () => verifier(grokHome(), new FakeGrok(applied()), "win32").verify(snapshot()),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GROK_ISOLATION_PLATFORM_BLOCKED",
  );
});

test("MCP servers in the operator's Grok home stop the run rather than ride along in it", async () => {
  const home = grokHome("[mcp_servers.example]\ncommand = \"node\"\n");
  // An MCP server is an arbitrary process with its own network access, inside the sandbox with
  // the run, and there is no per-invocation way to turn one off.
  await assert.rejects(
    () => verifier(home, new FakeGrok(applied())).verify(snapshot()),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GROK_ISOLATION_SELF_TEST_FAILED",
  );
});

test("hooks and plugins are reported rather than refused, so doctor can name them", () => {
  const home = grokHome("[marketplace]\ndefault = true\n");
  writeFileSync(join(home, "hooks-paths"), "/somewhere/hook.json\n", "utf8");
  assert.deepEqual([...grokConfigSurfaces(home)].sort(), ["hooks", "plugins"]);
  assert.deepEqual(grokConfigSurfaces(grokHome()), []);
});

test("the Grok home is the operator's, located without reading anything inside it", () => {
  assert.equal(resolveGrokHome({ GROK_HOME: "/custom/grok" }), "/custom/grok");
  assert.equal(resolveGrokHome({ HOME: "/home/someone" }), join("/home/someone", ".grok"));
});

test("an unavailable CLI is not attested", async () => {
  const root = mkdtempSync(join(tmpdir(), "braingate-grok-unavailable-"));
  mkdirSync(join(root, "unused"), { recursive: true });
  await assert.rejects(
    () => verifier(grokHome(), new FakeGrok(applied())).verify(snapshot({ available: false })),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GROK_ISOLATION_UNAVAILABLE",
  );
});

test("a build that keeps its record somewhere else is still read, rather than failing on a file move", async () => {
  const home = grokHome();
  // Measured against grok 1.0.24: the log moved to `$GROK_HOME/sessions/sandbox-events.jsonl`.
  const attestation = await verifier(home, new FakeGrok(applied(), "", "sessions")).verify(snapshot());
  assert.equal(attestation.source, "sandbox-event-self-test");
});

test("a profile that only warned instead of applying fails the self-test", async () => {
  const home = grokHome();
  // 1.0.24 no longer refuses to start: an unfound custom profile warns and continues with
  // exit 0, which is why the words are read rather than the exit code trusted.
  await assert.rejects(
    verifier(home, new FakeGrok(applied(), "warning: sandbox could not be applied: Custom sandbox profile 'braingate-staged' not found.")).verify(snapshot()),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "GROK_ISOLATION_SELF_TEST_FAILED",
  );
});

test("the write profile is a different policy, and earns a different proof", () => {
  assert.notEqual(GROK_WRITE_SANDBOX.hash, GROK_STAGED_SANDBOX.hash);
  assert.match(GROK_WRITE_SANDBOX.toml, /deny = \[/);
  assert.doesNotMatch(GROK_STAGED_SANDBOX.toml, /deny = \[/);
});
