import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
 * Which self-test contract a Grok attestation was earned under, per posture.
 *
 * The staged contract reads the applied policy back. The snapshot-read contract does that *and* proves
 * the posture a project copy needs: a BrainGate-isolated home with no operator plugins, and no writable
 * root at all. A future Grok release whose grants change must earn the current contract; an older proof
 * cannot become sufficient merely because the profile strings happen to match.
 */
export const GROK_STAGED_PROBE_VERSION = "grok-sandbox-event-self-test-v2";
export const GROK_SNAPSHOT_PROBE_VERSION = "grok-snapshot-read-self-test-v2";

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

function sandboxPolicy(input: { readonly name: string; readonly extends: string; readonly restrictNetwork: boolean; readonly deny?: readonly string[]; readonly home?: "operator" | "isolated" }): GrokSandboxPolicy {
  const definition = Object.freeze({
    schemaVersion: 1,
    profile: input.name,
    extends: input.extends,
    restrictNetwork: input.restrictNetwork,
    // Which Grok home the run executes from is part of the policy, not an implementation detail: a
    // home that carries the operator's plugins and hooks grants a plugin far more reach than the same
    // profile does from an empty one. The hash says which posture the attestation was earned under.
    home: input.home ?? "operator",
    ...(input.deny === undefined ? {} : { deny: input.deny }),
  });
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
 * The profile a **read-primary snapshot** run uses.
 *
 * It is a separate policy rather than a reuse of `braingate-staged` for one reason that is not a role
 * name: the home is different. A staged role runs from the operator's Grok home, which on this machine
 * carries installed plugins and Claude-Code hook configuration; the snapshot-primary posture runs from
 * a BrainGate-created home that holds a minimal configuration and a *reference* to the credential, and
 * nothing else. That changes what a plugin could reach — from a copy of the project's source tree —
 * so it is a different policy with a different hash, earned by its own self-test.
 *
 * The sandbox posture itself is the same `strict` base with network restricted, and the deny list is
 * the same idea as the write profile's: a credential is unreadable rather than merely off-limits.
 */
/*
 * MEASURED 2026-09-12, grok 1.0.24, darwin, and it is why xAI read-primary is not eligible:
 *
 * the applied `strict` profile lists the workspace under `read_only_paths` *and* under
 * `read_write_paths` (the same directory through macOS's `/private` alias), so Grok grants write
 * access to its own working directory. A project copy a provider can rewrite is not a read-only
 * workspace, whatever the flags say, so the snapshot-primary self-test below refuses this posture
 * and `braingate doctor` reports the grants it saw. The profile is kept because it is the posture a
 * future build would have to earn: the moment a Grok release can deny writes inside its workspace,
 * this proof becomes earnable and nothing else has to change.
 */
export const GROK_SNAPSHOT_READ_SANDBOX: GrokSandboxPolicy = sandboxPolicy({
  name: "braingate-snapshot-read",
  extends: "strict",
  restrictNetwork: true,
  home: "isolated",
  deny: Object.freeze(["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/credentials*", "**/.git/config"]),
});

export function grokSnapshotReadProfileHash(): string {
  return GROK_SNAPSHOT_READ_SANDBOX.hash;
}

/**
 * The Grok home a snapshot-primary run executes from.
 *
 * BrainGate creates it: one file of its own configuration, and the operator's `auth.json` **referenced
 * by symlink** rather than copied — so no credential is duplicated anywhere and the operator's own
 * `grok` sessions keep working unchanged. What is deliberately absent is everything else the operator's
 * home carries: installed plugins, hook configuration, MCP servers, marketplace state, memory.
 */
export function createIsolatedGrokHome(input: { readonly root: string; readonly realHome: string }): { readonly home: string; readonly credentialReferenced: boolean } {
  const home = join(input.root, "grok-home");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const credential = join(input.realHome, "auth.json");
  const referenced = existsSync(credential);
  if (referenced) symlinkSync(credential, join(home, "auth.json"));
  writeFileSync(join(home, "config.toml"), "# BrainGate-owned Grok home for a read-only snapshot run.\n", { encoding: "utf8", mode: 0o600 });
  return Object.freeze({ home, credentialReferenced: referenced });
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
  /** The self-test contract this proof was earned under; absent on records written before it existed. */
  readonly probeVersion?: string;
  readonly version: string;
  readonly platform: "darwin" | "linux";
  readonly profileHash: string;
  /** Path roots Grok reported it would allow reads from, as recorded by its own event log. */
  readonly readableRoots: readonly string[];
  /**
   * Roots the applied profile granted *write* access to.
   *
   * Recorded so a read-only claim is a fact about the kernel rather than a hope: the snapshot-primary
   * attestation is valid only when the workspace is absent from this list.
   */
  readonly writableRoots?: readonly string[];
  /** Whether the proof was earned from a BrainGate-created home rather than the operator's. */
  readonly isolatedHome?: boolean;
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
  options: {
    readonly platform?: NodeJS.Platform;
    readonly now?: Date;
    readonly policy?: GrokSandboxPolicy;
    /**
     * The self-test contract the caller needs. Omitted means any contract this policy accepts; a
     * caller that needs the snapshot posture asks for it by name, and a proof from an older contract
     * does not satisfy the request.
     */
    readonly minProbeVersion?: string;
  } = {},
): boolean {
  if (value === undefined || value.providerId !== "xai" || value.source !== "sandbox-event-self-test") return false;
  if (options.minProbeVersion !== undefined && value.probeVersion !== options.minProbeVersion) return false;
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
/**
 * Whether an attestation proves the snapshot-primary posture: the snapshot policy, an isolated home,
 * and a workspace the kernel will not let the provider write to.
 */
export function validGrokSnapshotReadAttestation(
  value: GrokIsolationAttestation | undefined,
  snapshot: ProviderSnapshot,
  options: { readonly now?: Date; readonly projectPaths?: readonly string[] } = {},
): boolean {
  if (value === undefined) return false;
  // Both halves of the identity: the snapshot policy *and* the snapshot-read contract.
  if (!validGrokIsolationAttestation(value, snapshot, { ...options, policy: GROK_SNAPSHOT_READ_SANDBOX, minProbeVersion: GROK_SNAPSHOT_PROBE_VERSION })) return false;
  if (value.isolatedHome !== true) return false;
  if (!Array.isArray(value.writableRoots) || value.writableRoots.length > 0) return false;
  return true;
}

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
    options: { readonly projectPaths?: readonly string[]; readonly now?: Date; readonly policy?: GrokSandboxPolicy; readonly mode?: "staged" | "snapshot-read" } = {},
  ): Promise<GrokIsolationAttestation> {
    if (snapshot.providerId !== "xai") throw new BrainGateInvariantError("GROK_ISOLATION_PROVIDER_INVALID", "The Grok isolation verifier accepts only the xAI provider.");
    if (snapshot.available.value !== true) throw new BrainGateInvariantError("GROK_ISOLATION_UNAVAILABLE", "Grok CLI is unavailable.");
    const platform = platformGate(this.#platform);
    const version = normalizedVersion(snapshot);
    const now = options.now ?? new Date();
    const policy = options.policy ?? GROK_STAGED_SANDBOX;
    const operatorHome = resolveGrokHome(this.#baseEnv);
    const snapshotRead = options.mode === "snapshot-read";
    const root = mkdtempSync(join(tmpdir(), "braingate-grok-verify-"));
    const workspace = join(root, "workspace");
    const isolatedHome = join(root, "home");
    mkdirSync(join(workspace, ".grok"), { recursive: true, mode: 0o700 });
    mkdirSync(isolatedHome, { mode: 0o700 });
    writeFileSync(join(workspace, ".grok", "sandbox.toml"), policy.toml, { encoding: "utf8", mode: 0o600 });
    // The posture the attestation will speak for: a snapshot-primary run executes from BrainGate's own
    // Grok home, so that is what this self-test measures. A staged run keeps the operator's home,
    // because that is what a staged run actually uses.
    const isolated = snapshotRead ? createIsolatedGrokHome({ root, realHome: operatorHome }) : null;
    if (isolated !== null && !isolated.credentialReferenced) {
      throw new BrainGateInvariantError("GROK_ISOLATION_SELF_TEST_FAILED", `No Grok credential was found to reference from the isolated home (${join(operatorHome, "auth.json")}).`);
    }
    const grokHome = isolated === null ? operatorHome : isolated.home;
    if (isolated !== null) {
      const surfaces = grokConfigSurfaces(isolated.home);
      if (surfaces.length > 0) throw new BrainGateInvariantError("GROK_ISOLATION_SELF_TEST_FAILED", `The isolated Grok home still loads operator configuration: ${surfaces.join(", ")}.`);
    }

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
      // A copy of the project is worth no more than the checkout if the provider can rewrite it, so a
      // snapshot-primary proof must show the workspace read-only and nothing writable at all.
      if (snapshotRead) {
        const readWrite = [...(event.read_write_paths ?? [])];
        const workspaceReadOnly = (event.read_only_paths ?? []).some((path) => within(path, workspace) && within(workspace, path));
        if (!workspaceReadOnly) {
          // The grants are named in the failure, because "not read-only" has two very different causes:
          // a sandbox that does not enforce it, and a path reported under another name (macOS resolves
          // a workspace opened through a symlinked temp root). The first must stop the mode; the second
          // is an identity question the caller can answer.
          throw new BrainGateInvariantError(
            "GROK_ISOLATION_SELF_TEST_FAILED",
            `The applied Grok sandbox does not report the workspace as read-only, so writes into a snapshot could not be denied (workspace ${workspace}; read-only ${JSON.stringify(event.read_only_paths ?? [])}; read-write ${JSON.stringify(event.read_write_paths ?? [])}).`,
          );
        }
        if (readWrite.some((path) => within(path, workspace))) {
          throw new BrainGateInvariantError("GROK_ISOLATION_SELF_TEST_FAILED", "The applied Grok sandbox grants write access inside the workspace, so a snapshot would be mutable by the provider.");
        }
        if (readWrite.length > 0) {
          throw new BrainGateInvariantError("GROK_ISOLATION_SELF_TEST_FAILED", `The applied Grok sandbox grants write access to ${readWrite.join(", ")}, which a read-only run has no reason to need.`);
        }
        if (readable.some((path) => within(path, operatorHome))) {
          throw new BrainGateInvariantError("GROK_ISOLATION_SELF_TEST_FAILED", "The applied Grok sandbox can read the operator's Grok home, which carries their plugins and hooks.");
        }
      }

      return Object.freeze({
        providerId: "xai",
        source: "sandbox-event-self-test",
        version,
        platform,
        profileHash: policy.hash,
        probeVersion: snapshotRead ? GROK_SNAPSHOT_PROBE_VERSION : GROK_STAGED_PROBE_VERSION,
        readableRoots: Object.freeze([...(event.read_only_paths ?? [])]),
        writableRoots: Object.freeze([...(event.read_write_paths ?? [])]),
        ...(snapshotRead ? { isolatedHome: true } : {}),
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
