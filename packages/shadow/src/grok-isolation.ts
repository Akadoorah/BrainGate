import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import { SecretGuard } from "@braingate/security";
import { NodeCodexSandboxRunner, type CodexSandboxResult, type CodexSandboxRunner } from "./codex-isolation.js";

/**
 * Grok's per-invocation isolation, and why it exists now when it did not before.
 *
 * BrainGate previously refused to invoke Grok, for two reasons that were true when they were
 * measured: `grok inspect` reported its permissions source as `~/.claude/settings.local.json`
 * — a different tool's file, which BrainGate neither owns nor can neutralise for one call —
 * and a sandbox profile that could not be found produced a warning rather than a refusal, so
 * the run continued unsandboxed.
 *
 * Both were re-measured against grok 1.0.13 and neither holds:
 *
 * - `GROK_HOME` now locates configuration *and* credentials, so BrainGate can hand the child an
 *   isolated `HOME` — which removes the other tool's settings file from existence — while
 *   `GROK_HOME` keeps the operator's authentication. Verified: `grok inspect` under that pair
 *   reports `Permissions: (none), 0 loaded`, and `grok models` still reports a logged-in
 *   account.
 * - A *custom* sandbox profile that cannot be applied now aborts: "Refusing to start with its
 *   protections missing." (A built-in profile still only warns, which is why BrainGate defines
 *   its own rather than passing `--sandbox strict`.)
 *
 * What is enforced is kernel-level — Seatbelt on macOS, Landlock on Linux — and covers the
 * shell and subagents, not only the read tool: an outside `cat` fails with "Operation not
 * permitted". So the guarantee here is stronger than a prompt-level restriction, and it is
 * checked rather than assumed: every applied profile is logged by Grok itself, with the exact
 * path sets in force, and the self-test reads that log back.
 */

export const GROK_SANDBOX_PROFILE = "braingate-staged";

/**
 * A sandbox profile BrainGate defines, with the hash an attestation is bound to.
 *
 * There is more than one because a read and a write want different things from the kernel, and
 * an attestation earned under one must not silently cover the other: the hash is over the
 * policy, so a run under a different profile has no valid proof until its own self-test runs.
 */
export interface GrokSandboxPolicy {
  readonly name: string;
  readonly toml: string;
  readonly hash: string;
}

function sandboxPolicy(input: { readonly name: string; readonly extends: string; readonly restrictNetwork: boolean; readonly deny?: readonly string[] }): GrokSandboxPolicy {
  const definition = Object.freeze({ schemaVersion: 1, profile: input.name, extends: input.extends, restrictNetwork: input.restrictNetwork, ...(input.deny === undefined ? {} : { deny: input.deny }) });
  const lines = [
    `[profiles.${input.name}]`,
    `extends = "${input.extends}"`,
    `restrict_network = ${String(input.restrictNetwork)}`,
    ...(input.deny === undefined ? [] : [`deny = [${input.deny.map((pattern) => JSON.stringify(pattern)).join(", ")}]`]),
    "",
  ];
  return Object.freeze({
    name: input.name,
    toml: lines.join("\n"),
    hash: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
  });
}

/**
 * The `.grok/sandbox.toml` BrainGate writes into a staged workspace.
 *
 * `strict` is the narrowest base: reads are confined to the working directory and system paths,
 * so the project checkout and the operator's home are unreachable without naming them.
 * `restrict_network` blocks child-process network on Linux; on macOS it is a documented no-op,
 * which is why the attestation records the platform rather than claiming the same guarantee
 * everywhere.
 */
export const GROK_STAGED_SANDBOX: GrokSandboxPolicy = sandboxPolicy({ name: GROK_SANDBOX_PROFILE, extends: "strict", restrictNetwork: true });

/**
 * The profile a Grok write runs under, in the task worktree.
 *
 * `strict` already writes only to the working directory, which is the worktree and nothing else
 * on the machine. The deny list is what a settings file cannot give you: kernel-enforced for the
 * process and everything it spawns, so a secret is unreadable rather than off-limits by
 * instruction.
 */
export const GROK_WRITE_SANDBOX: GrokSandboxPolicy = sandboxPolicy({
  name: "braingate-write",
  extends: "strict",
  restrictNetwork: true,
  deny: Object.freeze(["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/credentials*", "**/.git/config"]),
});

export function grokSandboxProfileToml(): string {
  return GROK_STAGED_SANDBOX.toml;
}

export function grokIsolationProfileHash(): string {
  return GROK_STAGED_SANDBOX.hash;
}

/**
 * User-level Grok surfaces that will still load in a staged run, because they live in
 * `GROK_HOME` alongside the credentials the run needs.
 *
 * Isolating `HOME` removes the other tool's settings file, but `GROK_HOME` is the operator's
 * real Grok home and BrainGate will not copy credentials out of it to get a clean one. So what
 * that home configures — MCP servers, hooks, marketplace plugins — is inside the sandbox with
 * the run. The sandbox confines what they can read; it does not stop them existing.
 *
 * MCP servers are refused outright rather than reported: an MCP server is an arbitrary process
 * with its own network access, and BrainGate has no per-invocation way to turn one off. Hooks
 * and plugins are reported, so `braingate doctor` can say what is loaded instead of leaving the
 * operator to assume nothing is.
 */
export function grokConfigSurfaces(grokHome: string): readonly string[] {
  const surfaces: string[] = [];
  const config = readIfPresent(join(grokHome, "config.toml"));
  if (/^\s*\[\s*mcp_servers/m.test(config)) surfaces.push("mcp_servers");
  if (/^\s*\[\s*(?:plugins|marketplace)/m.test(config)) surfaces.push("plugins");
  const hooks = readIfPresent(join(grokHome, "hooks-paths")).trim();
  if (hooks.length > 0) surfaces.push("hooks");
  return Object.freeze(surfaces);
}

export interface GrokIsolationAttestation {
  readonly providerId: "xai";
  readonly source: "sandbox-event-self-test";
  readonly version: string;
  readonly platform: "darwin" | "linux";
  readonly profileHash: string;
  /** Path roots Grok reported it would allow reads from, as recorded by its own event log. */
  readonly readableRoots: readonly string[];
  /** False on macOS, where child-process network blocking is a documented no-op. */
  readonly networkRestricted: boolean;
  /** User-level Grok surfaces loaded inside the sandbox; see grokConfigSurfaces. */
  readonly configSurfaces: readonly string[];
  readonly observedAt: string;
  readonly expiresAt: string;
}

/**
 * Roots `strict` grants that BrainGate accepts: the operating system, and the caller-supplied
 * workspace and Grok home. Anything else in the applied policy means the profile in force is
 * not the one BrainGate wrote — the likeliest cause being a same-named profile in the
 * operator's own `sandbox.toml`, which Grok resolves in preference to the project file.
 */
const SYSTEM_ROOTS: readonly string[] = Object.freeze([
  "/usr", "/bin", "/sbin", "/etc", "/dev", "/tmp", "/var", "/System", "/Library", "/private", "/opt", "/proc", "/sys", "/run", "/nix",
]);

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function platformGate(platform: NodeJS.Platform): "darwin" | "linux" {
  if (platform === "win32") {
    throw new BrainGateInvariantError("GROK_ISOLATION_PLATFORM_BLOCKED", "Grok's sandbox is implemented with Seatbelt and Landlock, neither of which exists on native Windows. Use WSL instead.");
  }
  if (platform !== "darwin" && platform !== "linux") {
    throw new BrainGateInvariantError("GROK_ISOLATION_PLATFORM_BLOCKED", `Grok sandbox isolation is not verified on platform ${platform}.`);
  }
  return platform;
}

function normalizedVersion(snapshot: ProviderSnapshot): string {
  const value = snapshot.version.value?.trim() ?? "";
  if (value.length === 0) throw new BrainGateInvariantError("GROK_ISOLATION_VERSION_UNKNOWN", "Grok version is unknown; isolation cannot be attested.");
  return value;
}

export function validGrokIsolationAttestation(
  value: GrokIsolationAttestation | undefined,
  snapshot: ProviderSnapshot,
  options: { readonly platform?: NodeJS.Platform; readonly now?: Date; readonly policy?: GrokSandboxPolicy } = {},
): boolean {
  if (value === undefined || value.providerId !== "xai" || value.source !== "sandbox-event-self-test") return false;
  const platform = platformGate(options.platform ?? process.platform);
  // An attestation earned under the read profile does not cover a write: the hash is over the
  // policy, so asking for the wrong one has no proof rather than the nearest available one.
  const policy = options.policy ?? GROK_STAGED_SANDBOX;
  if (value.platform !== platform || value.version !== normalizedVersion(snapshot) || value.profileHash !== policy.hash) return false;
  const now = options.now ?? new Date();
  const observed = new Date(value.observedAt);
  const expires = new Date(value.expiresAt);
  if (Number.isNaN(observed.getTime()) || Number.isNaN(expires.getTime())) return false;
  if (observed.getTime() > now.getTime() + 60_000) return false;
  return expires.getTime() > now.getTime();
}

interface ProfileAppliedEvent {
  readonly event_type: string;
  readonly profile: string;
  readonly workspace: string;
  readonly enforced: boolean;
  readonly restrict_network?: boolean;
  readonly read_write_paths?: readonly string[];
  readonly read_only_paths?: readonly string[];
}

/** The last `ProfileApplied` event Grok recorded for this workspace, or null. */
export function latestProfileApplied(log: string, workspace: string): ProfileAppliedEvent | null {
  let found: ProfileAppliedEvent | null = null;
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let event: ProfileAppliedEvent;
    try { event = JSON.parse(line) as ProfileAppliedEvent; }
    catch { continue; }
    if (event.event_type !== "ProfileApplied" || typeof event.workspace !== "string") continue;
    let sameWorkspace = event.workspace === workspace;
    if (!sameWorkspace) {
      // macOS reports the resolved path (/private/tmp/x) for a workspace opened as /tmp/x.
      try { sameWorkspace = statSync(event.workspace).ino === statSync(workspace).ino; }
      catch { sameWorkspace = false; }
    }
    if (sameWorkspace) found = event;
  }
  return found;
}

/**
 * Path roots the applied policy grants that BrainGate did not expect.
 *
 * A shadowing profile that extends `devbox` rather than `strict` shows up here as the home
 * directory or `/` appearing among the readable roots — which is exactly the case a hash over
 * BrainGate's own configuration file cannot catch, because that file was never the one used.
 */
export function unexpectedRoots(event: ProfileAppliedEvent, allowed: readonly string[]): readonly string[] {
  const permitted = [...SYSTEM_ROOTS, ...allowed];
  const granted = [...(event.read_only_paths ?? []), ...(event.read_write_paths ?? [])];
  const unexpected = granted.filter((path) => !permitted.some((root) => within(root, path)));
  return Object.freeze([...new Set(unexpected)].sort());
}

export class GrokIsolationVerifier {
  readonly #runner: CodexSandboxRunner;
  readonly #platform: NodeJS.Platform;
  readonly #baseEnv: NodeJS.ProcessEnv;
  readonly #secretGuard = new SecretGuard();

  constructor(options: { readonly runner?: CodexSandboxRunner; readonly platform?: NodeJS.Platform; readonly env?: NodeJS.ProcessEnv } = {}) {
    // The same bounded spawn helper the Codex self-test uses: a probe with a hard timeout, an
    // output cap, and redaction. Nothing about it is Codex-specific.
    this.#runner = options.runner ?? new NodeCodexSandboxRunner();
    this.#platform = options.platform ?? process.platform;
    this.#baseEnv = options.env ?? process.env;
  }

  /**
   * Proves the sandbox without spending a token.
   *
   * Grok applies the profile at process start and logs it before it validates the requested
   * model, so a run naming a model that cannot exist aborts after the policy is in force and
   * before any model work. The evidence is Grok's own record of what the kernel is enforcing,
   * not BrainGate's account of what it asked for.
   */
  async verify(
    snapshot: ProviderSnapshot,
    options: { readonly projectPaths?: readonly string[]; readonly now?: Date; readonly policy?: GrokSandboxPolicy } = {},
  ): Promise<GrokIsolationAttestation> {
    if (snapshot.providerId !== "xai") throw new BrainGateInvariantError("GROK_ISOLATION_PROVIDER_INVALID", "The Grok isolation verifier accepts only the xAI provider.");
    if (snapshot.available.value !== true) throw new BrainGateInvariantError("GROK_ISOLATION_UNAVAILABLE", "Grok CLI is unavailable.");
    const platform = platformGate(this.#platform);
    const version = normalizedVersion(snapshot);
    const now = options.now ?? new Date();
    const policy = options.policy ?? GROK_STAGED_SANDBOX;
    const grokHome = resolveGrokHome(this.#baseEnv);
    const root = mkdtempSync(join(tmpdir(), "braingate-grok-verify-"));
    const workspace = join(root, "workspace");
    const isolatedHome = join(root, "home");
    mkdirSync(join(workspace, ".grok"), { recursive: true, mode: 0o700 });
    mkdirSync(isolatedHome, { mode: 0o700 });
    writeFileSync(join(workspace, ".grok", "sandbox.toml"), policy.toml, { encoding: "utf8", mode: 0o600 });

    // Per file, because either one may be the one this build writes and a mark taken across
    // both would shift the moment the other grows.
    const before = grokSandboxEventLogs(grokHome).map((log) => log.length);

    try {
      const environment = this.#secretGuard.buildEnvironment(this.#baseEnv, {
        allowedAdditionalKeys: ["GROK_HOME"],
        overrides: { GROK_HOME: grokHome, HOME: isolatedHome },
      });
      environment.env.CI = "1";
      environment.env.TERM = "dumb";
      const result = await this.#runner.run({
        binary: snapshot.binary,
        args: ["-p", "probe", "--cwd", workspace, "--sandbox", policy.name, "--model", GROK_PROBE_MODEL, "--output-format", "json"],
        cwd: workspace,
        env: environment.env,
      });
      if (!result.spawned) throw new BrainGateInvariantError("GROK_ISOLATION_SELF_TEST_FAILED", "The Grok CLI could not be started for the sandbox self-test.");
      if (grokSandboxNotApplied(`${result.stdout}\n${result.stderr}`)) {
        throw new BrainGateInvariantError("GROK_ISOLATION_SELF_TEST_FAILED", "Grok did not apply the BrainGate sandbox profile, so its protections were not in force.");
      }

      // Read from wherever this build writes it. grok 1.0.24 moved the log into
      // `$GROK_HOME/sessions/`, and reading only the old path found nothing — which fails
      // closed, but fails closed on a file move rather than on a missing protection.
      const appended = grokSandboxEventsSince(grokHome, before);
      const event = latestProfileApplied(appended, workspace);
      if (event === null) {
        throw new BrainGateInvariantError("GROK_ISOLATION_SELF_TEST_FAILED", "Grok recorded no applied sandbox profile for the staged workspace, so nothing proves the profile took effect.");
      }
      if (event.profile !== policy.name || event.enforced !== true) {
        throw new BrainGateInvariantError("GROK_ISOLATION_SELF_TEST_FAILED", `Grok applied profile ${event.profile} with enforced=${String(event.enforced)}, not an enforced BrainGate profile.`);
      }
      const surfaces = grokConfigSurfaces(grokHome);
      if (surfaces.includes("mcp_servers")) {
        throw new BrainGateInvariantError(
          "GROK_ISOLATION_SELF_TEST_FAILED",
          "Grok's home configures MCP servers, and BrainGate cannot disable them for one invocation. Remove or disable them with `grok mcp` before routing tasks to Grok.",
        );
      }
      const unexpected = unexpectedRoots(event, [workspace, grokHome, root, join(homedir(), "Library")]);
      if (unexpected.length > 0) {
        throw new BrainGateInvariantError(
          "GROK_ISOLATION_SELF_TEST_FAILED",
          `The sandbox profile in force grants paths BrainGate did not define (${unexpected.slice(0, 3).join(", ")}). A profile named ${policy.name} in your own sandbox.toml takes precedence over BrainGate's; rename or remove it.`,
        );
      }
      // Whatever the roots say in general, the concrete claim is about this operator's project.
      const readable = [...(event.read_only_paths ?? []), ...(event.read_write_paths ?? [])];
      const reachable = (options.projectPaths ?? []).filter((path) => readable.some((granted) => within(granted, path)));
      if (reachable.length > 0) {
        throw new BrainGateInvariantError("GROK_ISOLATION_SELF_TEST_FAILED", "The applied Grok sandbox would still reach the registered project checkout.");
      }

      return Object.freeze({
        providerId: "xai",
        source: "sandbox-event-self-test",
        version,
        platform,
        profileHash: policy.hash,
        readableRoots: Object.freeze([...(event.read_only_paths ?? [])]),
        // Recorded rather than claimed: on macOS Grok reports the request but the kernel does
        // not block child-process network, and an attestation that said otherwise would be a
        // guarantee BrainGate cannot keep.
        networkRestricted: platform === "linux" && event.restrict_network === true,
        configSurfaces: surfaces,
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

/**
 * A model id no catalogue can contain, so the probe aborts at model validation.
 *
 * The sandbox is already applied and logged by then, which is what makes the self-test free:
 * it reads a policy decision Grok has already made rather than paying for a completion to
 * observe it.
 */
export const GROK_PROBE_MODEL = "__braingate_sandbox_probe__";

export function resolveGrokHome(env: NodeJS.ProcessEnv): string {
  const configured = env.GROK_HOME?.trim();
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  const home = env.HOME ?? homedir();
  if (home.length === 0) throw new BrainGateInvariantError("GROK_HOME_UNKNOWN", "Grok's home cannot be located without GROK_HOME or HOME.");
  return join(home, ".grok");
}

function readIfPresent(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch { return ""; }
}

/**
 * Grok's own record of the policies it applied, from wherever this build keeps it.
 *
 * Measured 2026-09-09 against grok 1.0.24: the log moved from `$GROK_HOME/sandbox-events.jsonl`
 * to `$GROK_HOME/sessions/sandbox-events.jsonl`. Both are read, newest last, so an older build
 * and a current one both answer the same question. A missing file is an empty log, never an
 * error: absence of evidence fails the self-test on its own.
 */
export function grokSandboxEventLogs(grokHome: string): readonly string[] {
  return Object.freeze([readIfPresent(join(grokHome, "sandbox-events.jsonl")), readIfPresent(join(grokHome, "sessions", "sandbox-events.jsonl"))]);
}

/** What each log gained since the marks were taken, as one text. */
export function grokSandboxEventsSince(grokHome: string, marks: readonly number[]): string {
  return grokSandboxEventLogs(grokHome).map((log, index) => log.slice(marks[index] ?? 0)).join("\n");
}

/**
 * Whether Grok told us, in its own words, that the sandbox is not in force.
 *
 * ADR 0009 rested on a custom profile that cannot be applied aborting the run. Re-measured
 * against grok 1.0.24, it does not: a profile it cannot find now prints "sandbox could not be
 * applied" and continues with exit 0. So the words are read rather than trusted, on the
 * self-test and on every real run — because a run that continues unsandboxed is precisely the
 * case the attestation was supposed to have made impossible.
 */
export function grokSandboxNotApplied(output: string): boolean {
  return /refusing to start/i.test(output) || /sandbox could not be applied/i.test(output);
}

export type { CodexSandboxResult as GrokSandboxResult, CodexSandboxRunner as GrokSandboxRunner };
