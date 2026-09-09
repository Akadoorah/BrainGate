import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import { SecretGuard, redactSecrets } from "@braingate/security";
import { STAGE_PATH_TOKEN } from "./types.js";

export const CODEX_REVIEW_PROFILE = "braingate-review";

export const CODEX_REVIEW_DISABLED_FEATURES = Object.freeze([
  // Mirrors the isolation-oriented temporary structured request surface in current Codex,
  // then adds other external/tool surfaces BrainGate does not need for review.
  "apps",
  "code_mode",
  "code_mode_only",
  "context_management",
  "current_time_reminder",
  "deferred_executor",
  "enable_fanout",
  "goals",
  "hooks",
  "image_generation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "request_permissions_tool",
  "shell_snapshot",
  "shell_tool",
  "standalone_web_search",
  "token_budget",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "browser_use",
  "browser_use_full_cdp_access",
  "browser_use_external",
  "computer_use",
  "enable_mcp_apps",
  "network_proxy",
  "remote_plugin",
  // Restored: this is the declared intent, not a list of keys the current CLI happens to
  // accept. Codex 0.153.4 no longer knows it, and the self-test drops it there (ADR 0006).
  "worktrees",
] as const);

const PROFILE_POLICY = Object.freeze({
  schemaVersion: 2,
  filesystem: Object.freeze({ root: "none", minimal: "read", stage: "read" }),
  network: false,
  role: "reviewer-only",
  skills: Object.freeze({ orchestratorEnabled: false, includeInstructions: false, bundledEnabled: false, skipHostDiscoveryRequested: true }),
  disabledFeatures: CODEX_REVIEW_DISABLED_FEATURES,
});

export interface CodexIsolationAttestation {
  readonly providerId: "openai";
  readonly source: "sandbox-self-test";
  readonly version: string;
  readonly platform: "darwin" | "linux";
  readonly profileHash: string;
  /**
   * Declared control keys this Codex build does not recognise (ADR 0006). A key the CLI
   * rejects as unknown names a feature that build does not have, so nothing is left enabled
   * by omitting it. They are recorded, and reported by `braingate doctor`, so a control
   * disappearing upstream is visible rather than silent.
   */
  readonly droppedFeatureKeys: readonly string[];
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface CodexSandboxResult {
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface CodexSandboxRunner {
  run(input: {
    readonly binary: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  }): Promise<CodexSandboxResult>;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Binds an attestation to the controls actually in force (ADR 0006). Covering the *accepted*
 * key set rather than the declared one means a change in what the installed Codex honours
 * invalidates the attestation and forces a fresh self-test, instead of silently reusing an
 * attestation earned under a different set of controls.
 */
export function codexIsolationProfileHash(acceptedFeatureKeys: readonly string[] = CODEX_REVIEW_DISABLED_FEATURES): string {
  const accepted = [...acceptedFeatureKeys].sort();
  return createHash("sha256").update(JSON.stringify({ policy: PROFILE_POLICY, accepted })).digest("hex");
}

/** Declared keys minus the ones this build rejected as unknown. */
export function acceptedFeatureKeys(droppedFeatureKeys: readonly string[]): readonly string[] {
  const dropped = new Set(droppedFeatureKeys);
  return Object.freeze(CODEX_REVIEW_DISABLED_FEATURES.filter((key) => !dropped.has(key)));
}

/**
 * Where Codex keeps its configuration, credentials and the files it produces.
 *
 * Generated images land under `generated_images/<session>/` inside it, named by the CLI rather
 * than by the model — which is why BrainGate looks there instead of asking what path was used.
 */
export function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const configured = env.CODEX_HOME?.trim();
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  const home = env.HOME ?? homedir();
  if (home.length === 0) throw new BrainGateInvariantError("CODEX_HOME_UNKNOWN", "Codex's home cannot be located without CODEX_HOME or HOME.");
  return join(home, ".codex");
}

export const CODEX_GENERATED_IMAGES = "generated_images";

export function codexPermissionInlineTable(stagePath: string): string {
  const name = tomlString(CODEX_REVIEW_PROFILE);
  return `{ ${name} = { filesystem = { ":root" = "none", ":minimal" = "read", ${tomlString(stagePath)} = "read" }, network = { enabled = false } } }`;
}

export function codexReviewerConfigArgs(stagePath = STAGE_PATH_TOKEN, featureKeys: readonly string[] = CODEX_REVIEW_DISABLED_FEATURES): readonly string[] {
  const args: string[] = [
    "-c", `default_permissions=${tomlString(CODEX_REVIEW_PROFILE)}`,
    "-c", `permissions=${codexPermissionInlineTable(stagePath)}`,
    "-c", "web_search=\"disabled\"",
    // These match the isolation controls used by Codex's own temporary structured request path.
    "-c", "orchestrator.skills.enabled=false",
    "-c", "skills.include_instructions=false",
    "-c", "skills.bundled.enabled=false",
    "-c", "features.skip_host_skill_discovery=true",
    "-c", "tools.experimental_request_user_input.enabled=false",
    "-c", "tools.update_plan.enabled=false",
  ];
  for (const feature of featureKeys) args.push("-c", `features.${feature}=false`);
  return Object.freeze(args);
}

const UNKNOWN_FIELD = /unknown configuration field `([^`]+)`/;

/**
 * Partitions the declared control keys into the ones this Codex build accepts and the ones it
 * rejects as unknown (ADR 0006).
 *
 * `--strict-config` reports one unknown key per run, so the probe submits the whole set and
 * drops whatever the CLI names, until nothing is rejected. That is one invocation in the
 * common case and at most one per declared key.
 *
 * The probe spends nothing: `CODEX_HOME` points at an empty directory, so a run that gets past
 * config validation has no credentials and is refused before any model work. Config parsing
 * happens first, which is exactly the signal being read.
 */
async function probeFeatureKeys(
  runner: CodexSandboxRunner,
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly accepted: readonly string[]; readonly dropped: readonly string[] }> {
  let candidates: string[] = [...CODEX_REVIEW_DISABLED_FEATURES];
  const dropped: string[] = [];

  for (let attempt = 0; attempt <= CODEX_REVIEW_DISABLED_FEATURES.length; attempt += 1) {
    const args = ["exec", "--strict-config", "--skip-git-repo-check", "--json"];
    for (const feature of candidates) args.push("-c", `features.${feature}=false`);
    args.push("-");

    const result = await runner.run({ binary, args, cwd, env });
    const reported = UNKNOWN_FIELD.exec(`${result.stdout}\n${result.stderr}`)?.[1];
    if (reported === undefined) return { accepted: Object.freeze(candidates), dropped: Object.freeze(dropped) };

    const key = reported.startsWith("features.") ? reported.slice("features.".length) : reported;
    if (!candidates.includes(key)) {
      throw new BrainGateInvariantError(
        "CODEX_ISOLATION_CONFIG_REJECTED",
        `Codex rejected configuration field \`${reported}\`, which is not one of BrainGate's declared feature keys.`,
      );
    }
    candidates = candidates.filter((candidate) => candidate !== key);
    dropped.push(key);
  }

  throw new BrainGateInvariantError("CODEX_ISOLATION_CONFIG_REJECTED", "Codex rejected every declared reviewer control key.");
}

function profileConfig(stagePath: string): string {
  return [
    `default_permissions = ${tomlString(CODEX_REVIEW_PROFILE)}`,
    "",
    `[permissions.${CODEX_REVIEW_PROFILE}.filesystem]`,
    `\":root\" = \"none\"`,
    `\":minimal\" = \"read\"`,
    `${tomlString(stagePath)} = \"read\"`,
    "",
    `[permissions.${CODEX_REVIEW_PROFILE}.network]`,
    "enabled = false",
    "",
  ].join("\n");
}

function normalizedVersion(snapshot: ProviderSnapshot): string {
  const value = snapshot.version.value?.trim() ?? "";
  if (value.length === 0) throw new BrainGateInvariantError("CODEX_ISOLATION_VERSION_UNKNOWN", "Codex version is unknown; isolation cannot be attested.");
  return value;
}

function platformGate(platform: NodeJS.Platform): "darwin" | "linux" {
  if (platform === "win32") {
    throw new BrainGateInvariantError("CODEX_ISOLATION_PLATFORM_BLOCKED", "Native Windows Codex reviewer is blocked until the upstream permission-profile deny-read regression is verified fixed. Use WSL instead.");
  }
  if (platform !== "darwin" && platform !== "linux") {
    throw new BrainGateInvariantError("CODEX_ISOLATION_PLATFORM_BLOCKED", `Codex reviewer isolation is not verified on platform ${platform}.`);
  }
  return platform;
}

export function validCodexIsolationAttestation(
  value: CodexIsolationAttestation | undefined,
  snapshot: ProviderSnapshot,
  options: { readonly platform?: NodeJS.Platform; readonly now?: Date } = {},
): boolean {
  if (value === undefined || value.providerId !== "openai" || value.source !== "sandbox-self-test") return false;
  const platform = platformGate(options.platform ?? process.platform);
  // The hash covers the controls actually in force, so it is recomputed from the attestation's
  // own dropped set. A dropped key that is not a declared key, or a hash that does not match
  // the resulting accepted set, means the attestation was not produced by this policy.
  const dropped = value.droppedFeatureKeys ?? [];
  if (!Array.isArray(dropped) || dropped.some((key) => !CODEX_REVIEW_DISABLED_FEATURES.includes(key))) return false;
  if (value.platform !== platform || value.version !== normalizedVersion(snapshot) || value.profileHash !== codexIsolationProfileHash(acceptedFeatureKeys(dropped))) return false;
  const now = options.now ?? new Date();
  const observed = new Date(value.observedAt);
  const expires = new Date(value.expiresAt);
  if (Number.isNaN(observed.getTime()) || Number.isNaN(expires.getTime())) return false;
  if (observed.getTime() > now.getTime() + 60_000) return false;
  return expires.getTime() > now.getTime();
}

export class NodeCodexSandboxRunner implements CodexSandboxRunner {
  async run(input: {
    readonly binary: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  }): Promise<CodexSandboxResult> {
    return await new Promise((resolveResult) => {
      let stdout = "";
      let stderr = "";
      let spawned = false;
      let timedOut = false;
      let settled = false;
      const child = spawn(input.binary, [...input.args], { cwd: input.cwd, env: input.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.on("spawn", () => { spawned = true; });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, Math.min(Math.max(input.timeoutMs ?? 10_000, 1_000), 30_000));
      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        const current = target === "stdout" ? stdout : stderr;
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > 64 * 1024) { timedOut = true; child.kill("SIGKILL"); return; }
        if (target === "stdout") stdout = next; else stderr = next;
      };
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult(Object.freeze({ spawned, exitCode, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), timedOut }));
      };
      child.on("error", (error) => { stderr += `\n${error.message}`; finish(null); });
      child.on("close", (code) => finish(code));
    });
  }
}

export class CodexIsolationVerifier {
  readonly #runner: CodexSandboxRunner;
  readonly #platform: NodeJS.Platform;
  readonly #baseEnv: NodeJS.ProcessEnv;
  readonly #secretGuard = new SecretGuard();

  constructor(options: { readonly runner?: CodexSandboxRunner; readonly platform?: NodeJS.Platform; readonly env?: NodeJS.ProcessEnv } = {}) {
    this.#runner = options.runner ?? new NodeCodexSandboxRunner();
    this.#platform = options.platform ?? process.platform;
    this.#baseEnv = options.env ?? process.env;
  }

  async verify(snapshot: ProviderSnapshot, now = new Date()): Promise<CodexIsolationAttestation> {
    if (snapshot.providerId !== "openai") throw new BrainGateInvariantError("CODEX_ISOLATION_PROVIDER_INVALID", "Codex isolation verifier accepts only the OpenAI provider.");
    if (snapshot.available.value !== true) throw new BrainGateInvariantError("CODEX_ISOLATION_UNAVAILABLE", "Codex CLI is unavailable.");
    const platform = platformGate(this.#platform);
    const version = normalizedVersion(snapshot);
    const root = mkdtempSync(join(tmpdir(), "braingate-codex-verify-"));
    const codexHome = join(root, "codex-home");
    const stage = join(root, "stage");
    const outside = join(root, "outside");
    mkdirSync(codexHome, { mode: 0o700 });
    mkdirSync(stage, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    const insideFile = join(stage, "inside.txt");
    const outsideFile = join(outside, "outside.txt");
    const writeFile = join(stage, "write-denied.txt");
    writeFileSync(insideFile, "BRAINGATE_INSIDE_CANARY", { encoding: "utf8", mode: 0o600 });
    writeFileSync(outsideFile, "BRAINGATE_OUTSIDE_CANARY", { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(codexHome, "config.toml"), profileConfig(stage), { encoding: "utf8", mode: 0o600 });

    try {
      const environment = this.#secretGuard.buildEnvironment(this.#baseEnv, { allowedAdditionalKeys: ["CODEX_HOME"], overrides: { CODEX_HOME: codexHome } });
      environment.env.CI = "1";
      environment.env.TERM = "dumb";
      const base = ["sandbox", "--permission-profile", CODEX_REVIEW_PROFILE, "-C", stage, "--"] as const;
      const inside = await this.#runner.run({ binary: snapshot.binary, args: [...base, "/bin/cat", insideFile], cwd: stage, env: environment.env });
      if (!inside.spawned || inside.timedOut || inside.exitCode !== 0 || !inside.stdout.includes("BRAINGATE_INSIDE_CANARY")) {
        throw new BrainGateInvariantError("CODEX_ISOLATION_SELF_TEST_FAILED", "Codex sandbox could not read the explicitly allowed staged workspace.");
      }

      const deniedRead = await this.#runner.run({ binary: snapshot.binary, args: [...base, "/bin/cat", outsideFile], cwd: stage, env: environment.env });
      if (!deniedRead.spawned || deniedRead.timedOut || deniedRead.exitCode === 0 || deniedRead.stdout.includes("BRAINGATE_OUTSIDE_CANARY")) {
        throw new BrainGateInvariantError("CODEX_ISOLATION_SELF_TEST_FAILED", "Codex sandbox allowed reading outside the staged workspace.");
      }

      const deniedWrite = await this.#runner.run({ binary: snapshot.binary, args: [...base, "/bin/sh", "-c", "printf blocked > \"$1\"", "_", writeFile], cwd: stage, env: environment.env });
      if (!deniedWrite.spawned || deniedWrite.timedOut || deniedWrite.exitCode === 0 || existsSync(writeFile)) {
        throw new BrainGateInvariantError("CODEX_ISOLATION_SELF_TEST_FAILED", "Codex sandbox allowed writing inside the staged read-only workspace.");
      }

      // ADR 0006: the installed CLI, not a hand-edited list, decides which control keys are
      // in force. This runs only after the filesystem probes above have already proven the
      // sandbox, so a build that accepts a key but ignores it still fails closed.
      const probeHome = join(root, "probe-home");
      mkdirSync(probeHome, { mode: 0o700 });
      const probeEnv = this.#secretGuard.buildEnvironment(this.#baseEnv, { allowedAdditionalKeys: ["CODEX_HOME"], overrides: { CODEX_HOME: probeHome } });
      const keys = await probeFeatureKeys(this.#runner, snapshot.binary, stage, probeEnv.env);

      return Object.freeze({
        providerId: "openai",
        source: "sandbox-self-test",
        version,
        platform,
        profileHash: codexIsolationProfileHash(keys.accepted),
        droppedFeatureKeys: keys.dropped,
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
