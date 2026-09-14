import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import type { ModelRef } from "@braingate/router";
import { SecretGuard, redactSecrets } from "@braingate/security";
import { resolveToolGrant } from "@braingate/shadow";
import type { WriteProviderExecutor, WriteProviderPlan, WriteProviderResult } from "./types.js";

const CLAUDE_MINIMUM = "2.1.248";
const GENERIC_WRITE_PROMPT = "The piped JSON is the complete BrainGate task brief. Make only the requested small code change inside the current worktree. Do not run shell commands, access the network, use MCP, change agent/control-plane configuration, or touch secrets. Finish with the required structured summary.";

const WRITE_SCHEMA = Object.freeze({
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
});

/**
 * The deny entries that are policy rather than harness.
 *
 * Secrets and version-control internals are out of bounds under every policy — that is the
 * invariant, not a strict mode. The rest of `SETTINGS.permissions.deny` (a shell, a browser, the
 * runtime's own subagents, its MCP servers) is the harness BrainGate substituted for the CLI's, and
 * the DIRECT policy leaves that to the runtime.
 */
const SECRET_AND_VCS_DENY: readonly string[] = Object.freeze([
  "Read(.env)", "Read(.env.*)", "Read(**/.env)", "Read(**/.env.*)",
  "Read(credentials*)", "Read(**/credentials*)", "Read(**/*.pem)", "Read(**/*.key)",
  "Edit(.env)", "Edit(.env.*)", "Edit(**/.env)", "Edit(**/.env.*)",
  "Edit(credentials*)", "Edit(**/credentials*)", "Edit(**/*.pem)", "Edit(**/*.key)",
  "Edit(.git/**)", "Edit(.claude/**)", "Edit(.brain/**)", "Edit(.github/workflows/**)",
  "Edit(CLAUDE.md)", "Edit(AGENTS.md)", "Edit(AI_ENGINEERING_GUIDE.md)",
]);

const SETTINGS = Object.freeze({
  permissions: Object.freeze({
    disableBypassPermissionsMode: "disable",
    disableAutoMode: "disable",
    blockReadsOutsideWorkingDirectories: true,
    deny: Object.freeze([
      "Bash", "WebFetch", "WebSearch", "Agent", "NotebookEdit", "mcp__*",
      "Read(.env)", "Read(.env.*)", "Read(**/.env)", "Read(**/.env.*)",
      "Read(credentials*)", "Read(**/credentials*)", "Read(**/*.pem)", "Read(**/*.key)",
      "Edit(.env)", "Edit(.env.*)", "Edit(**/.env)", "Edit(**/.env.*)",
      "Edit(credentials*)", "Edit(**/credentials*)", "Edit(**/*.pem)", "Edit(**/*.key)",
      "Edit(.git/**)", "Edit(.claude/**)", "Edit(.brain/**)", "Edit(.github/workflows/**)",
      "Edit(CLAUDE.md)", "Edit(AGENTS.md)", "Edit(AI_ENGINEERING_GUIDE.md)"
    ]),
  }),
});

function tuple(value: string | null): readonly [number, number, number] | null {
  if (value === null) return null;
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function versionAtLeast(actual: string | null, minimum: string): boolean {
  const a = tuple(actual); const m = tuple(minimum);
  if (a === null || m === null) return false;
  for (let i = 0; i < 3; i += 1) { if (a[i]! > m[i]!) return true; if (a[i]! < m[i]!) return false; }
  return true;
}

export function assertClaudeWriteEligible(snapshot: ProviderSnapshot, model: ModelRef): void {
  if (snapshot.providerId !== "anthropic" || model.providerId !== "anthropic") throw new BrainGateInvariantError("WRITE_PROVIDER_BLOCKED", "M11 permits Claude Code as the only write-capable primary provider.");
  if (snapshot.available.value !== true) throw new BrainGateInvariantError("WRITE_PROVIDER_UNAVAILABLE", "Claude Code CLI is unavailable.");
  if (snapshot.authState.value !== "authenticated" || snapshot.authMode.value !== "subscription") throw new BrainGateInvariantError("WRITE_SUBSCRIPTION_REQUIRED", "Claude write mode requires proven Claude subscription authentication; API/unknown auth is refused.");
  if (!versionAtLeast(snapshot.version.value, CLAUDE_MINIMUM)) throw new BrainGateInvariantError("WRITE_VERSION_TOO_OLD", `Claude Code must be at least ${CLAUDE_MINIMUM} for restricted write mode.`);
  if (snapshot.capabilities.value.headless !== true || snapshot.capabilities.value.modelPinning !== true) throw new BrainGateInvariantError("WRITE_CAPABILITY_UNPROVEN", "Claude headless/model-pinning capability is not proven by discovery.");
  if (snapshot.models.value !== null && snapshot.models.value.length > 0 && !snapshot.models.value.includes(model.modelId)) throw new BrainGateInvariantError("WRITE_MODEL_UNAVAILABLE", `Routed model ${model.modelId} is not in Claude's discovered model list.`);
}

export function planClaudeWriteInvocation(input: {
  readonly snapshot: ProviderSnapshot;
  readonly model: ModelRef;
  readonly cwd: string;
  readonly task: string;
  readonly context: unknown;
  readonly findings?: readonly string[];
  readonly candidateOutput?: string | null;
  readonly maxTurns?: number;
  /**
   * Whether this write runs in the workspace itself under the DIRECT policy.
   *
   * The difference is the boundary, and it is the operator's choice rather than a capability: the
   * worktree profile *withholds* a shell because it cannot grant one inside a worktree, and under
   * DIRECT there is no such claim to make. What is passed instead is the runtime's own permission
   * mode, with BrainGate's tool allowlist, MCP denial and declared subagents left out — the three
   * restrictions ADR 0014 classifies as legacy (ADR 0017).
   */
  readonly nativeHarness?: boolean;
  /** The native session this write runs in, when one was resolved. */
  readonly session?: { readonly kind: string; readonly sessionId: string | null; readonly persistent: boolean } | null;
}): WriteProviderPlan {
  assertClaudeWriteEligible(input.snapshot, input.model);
  const nativeHarness = input.nativeHarness === true;
  const session = input.session ?? null;
  // A ceiling on pathology, not a budget: see ExecutionBudget.maxInspectionTurns.
  const maxTurns = Math.max(1, Math.min(60, Math.floor(input.maxTurns ?? 20)));
  const body = JSON.stringify(Object.freeze({
    schemaVersion: 1,
    task: input.task,
    context: input.context,
    findings: Object.freeze([...(input.findings ?? [])]),
    candidateOutput: input.candidateOutput ?? null,
    constraints: Object.freeze({
      smallChangeOnly: true,
      worktreeOnly: !nativeHarness,
      noShell: !nativeHarness,
      noNetwork: !nativeHarness,
      noSecrets: true,
      noAgentConfigChanges: true,
      // Recorded in the brief as well as the argv, so a worker that is resuming knows it is.
      resumedNativeSession: session !== null && session.kind === "resumed",
    }),
    responseContract: WRITE_SCHEMA,
  }));
  if (body.length === 0 || body.length > 2_000_000) throw new BrainGateInvariantError("WRITE_PAYLOAD_INVALID", "Write payload must be between 1 and 2,000,000 characters.");
  // A ceiling on pathology, not a budget: see ExecutionBudget.maxInspectionTurns. Clamping
  // lower than the budget asks for would silently reimpose the limit this stopped being.

  const args = Object.freeze([
    "--restricted",
    "--safe-mode",
    "-p", GENERIC_WRITE_PROMPT,
    "--output-format", "json",
    "--json-schema", JSON.stringify(WRITE_SCHEMA),
    // A write that is continuing a goal keeps its session, and a write that is not leaves none
    // behind. Both halves were hard-coded before: the flag was always here, so a DIRECT write could
    // never be resumed by the next compatible write — which is the continuity the M20 architecture
    // promises and the reason S2 did not exist in dogfood.
    ...(session !== null && session.kind === "resumed" && session.sessionId !== null ? ["--resume", session.sessionId] : []),
    ...(session !== null && session.kind === "fresh" && session.sessionId !== null ? ["--session-id", session.sessionId] : []),
    ...(session !== null && session.persistent ? [] : ["--no-session-persistence"]),
    "--no-chrome",
    "--disable-slash-commands",
    "--permission-mode", "acceptEdits",
    // In the workspace the runtime keeps its own harness: `--permission-mode acceptEdits` is the
    // CLI's own setting for "apply edits, ask for everything else", and the settings file keeps the
    // secret and version-control guards that are policy rather than harness. What is not passed is
    // the tool allowlist, the `mcp__*` denial and the MCP config BrainGate used to substitute for
    // the CLI's own — nor the shell denial, which existed because a worktree could not bound one.
    ...(nativeHarness
      ? ["--settings", JSON.stringify({ permissions: { ...SETTINGS.permissions, deny: SECRET_AND_VCS_DENY } })]
      : [
        // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, which this profile sets, makes Claude Code force
        // permission mode back to default, so --permission-mode alone leaves every Edit awaiting
        // an approval that never comes in a headless run and the task ends with no changes. The
        // CLI's own guidance is to declare the allowlist explicitly, which is narrower than a
        // permission mode: exactly these five tools, still under the deny list in --settings.
        "--tools", "Read,Glob,Grep,Edit,Write",
        "--allowedTools", "Read,Glob,Grep,Edit,Write",
        "--disallowedTools", "Bash,WebFetch,WebSearch,Agent,NotebookEdit,mcp__*",
        "--strict-mcp-config",
        "--mcp-config", "{\"mcpServers\":{}}",
        "--settings", JSON.stringify(SETTINGS),
      ]),
    "--max-turns", String(maxTurns),
    "--model", input.model.modelId,
  ]);
  if (args.some((arg) => /dangerously-skip|allow-dangerously|--bare|--worktree|--add-dir/.test(arg))) throw new BrainGateInvariantError("WRITE_PROFILE_UNSAFE", "Unsafe Claude write profile flag detected.");
  return Object.freeze({
    providerId: "anthropic",
    grant: resolveToolGrant({
      role: "primary", providerId: "anthropic",
      // The mode is what this invocation actually is: a worktree write, or a write in the workspace
      // the operator selected. Reported rather than assumed, because the grant is what the plan and
      // the receipt both read.
      workspaceMode: nativeHarness ? "project" : "task-worktree", writeMode: true,
      // Claude's boundary here is its settings file and its tool allowlist, not the kernel —
      // which is enough to withhold a shell and not enough to grant one.
      surface: { isolatedPerInvocation: true, toolDenial: !nativeHarness, declaredSubagents: !nativeHarness, enforcedSandbox: false },
      attested: true, operatorAccepted: false,
    }),
    executable: input.snapshot.binary,
    args,
    cwd: input.cwd,
    modelId: input.model.modelId,
    quotaPool: input.model.quotaPool,
    stdin: body,
    // `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is a BrainGate-invented hardening, and in the workspace it
    // is self-defeating: the CLI reacts to it by forcing the permission mode back to `default`, so
    // `--permission-mode acceptEdits` stops taking effect and every Edit waits for an approval that
    // a headless run can never give. Real dogfood showed it, in the CLI's own words:
    //
    //   ⚠ Permission mode forced to default — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set
    //     (allowed_non_write_users hardening). Declare allowedTools explicitly, or set
    //     CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to opt out.
    //
    // The worktree profile compensates with an explicit tool allowlist; the DIRECT profile
    // deliberately has none, because there the runtime keeps its own harness. So the scrub stays
    // where it was earned — the isolated worktree — and is not set in the operator's workspace,
    // where the operator has already approved the change at BrainGate's own prompt.
    allowedEnvKeys: Object.freeze(nativeHarness
      ? ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_SKIP_PROMPT_HISTORY"]
      : ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_SKIP_PROMPT_HISTORY", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"]),
    envOverrides: Object.freeze(nativeHarness
      ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" }
      : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" }),
  });
}

/**
 * Runs one executing-role invocation, for any provider that has a write profile.
 *
 * The name is historical: it ran only Claude when Claude was the only provider allowed to write.
 * Nothing in it was ever Claude-specific.
 */
export class NodeClaudeWriteExecutor implements WriteProviderExecutor {
  readonly #guard = new SecretGuard();

  async run(input: { readonly plan: WriteProviderPlan; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly maxOutputBytes?: number }): Promise<WriteProviderResult> {
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 5 * 60_000, 1_000), 20 * 60_000);
    const maxOutput = Math.min(Math.max(input.maxOutputBytes ?? 1024 * 1024, 8 * 1024), 8 * 1024 * 1024);
    const environment = this.#guard.buildEnvironment(input.env ?? process.env, { allowedAdditionalKeys: input.plan.allowedEnvKeys, overrides: input.plan.envOverrides });
    const placed = this.#placeFiles(input.plan);
    const started = Date.now();
    try {
      return await this.#spawn(input, environment, timeoutMs, maxOutput, started);
    } finally {
      // By exact path, and only the paths BrainGate wrote. Anything else the run left behind
      // still reaches the diff guard, which is the point of removing these one at a time rather
      // than clearing a directory.
      for (const path of placed) rmSync(path, { force: true });
    }
  }

  /**
   * Puts a CLI's own configuration where that CLI looks for it.
   *
   * Grok reads its sandbox profile from `.grok/sandbox.toml` under the working directory, which
   * for a write is the worktree the change is collected from — so the file has to be written
   * there and taken away before the diff. `wx` refuses to overwrite: a repository that already
   * has one fails the run rather than losing it.
   */
  #placeFiles(plan: WriteProviderPlan): readonly string[] {
    const placed: string[] = [];
    for (const [name, content] of Object.entries(plan.runtimeFiles ?? {})) {
      if (isAbsolute(name) || name.split("/").includes("..")) throw new BrainGateInvariantError("WRITE_RUNTIME_FILE_INVALID", "A runtime file must be a relative path inside the worktree.");
      const target = join(plan.cwd, name);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      placed.push(target);
    }
    for (const [path, content] of Object.entries(plan.externalFiles ?? {})) {
      if (!isAbsolute(path)) throw new BrainGateInvariantError("WRITE_EXTERNAL_FILE_INVALID", "An external file must be an absolute path outside the worktree.");
      if (!relative(plan.cwd, path).startsWith("..")) throw new BrainGateInvariantError("WRITE_EXTERNAL_FILE_INVALID", "An external file must not be inside the worktree, where it would join the diff.");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
      placed.push(path);
    }
    return Object.freeze(placed);
  }

  async #spawn(
    input: { readonly plan: WriteProviderPlan; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number; readonly maxOutputBytes?: number },
    environment: { readonly env: NodeJS.ProcessEnv; readonly removed: readonly string[] },
    timeoutMs: number,
    maxOutput: number,
    started: number,
  ): Promise<WriteProviderResult> {
    return await new Promise<WriteProviderResult>((resolveResult) => {
      let stdout = ""; let stderr = ""; let timedOut = false; let overflow = false; let spawned = false; let settled = false;
      const child = spawn(input.plan.executable, [...input.plan.args], { cwd: input.plan.cwd, env: environment.env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const finish = (exitCode: number | null) => {
        if (settled) return; settled = true; clearTimeout(timer);
        resolveResult(Object.freeze({ spawned, exitCode: overflow ? null : exitCode, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), timedOut: timedOut || overflow, durationMs: Date.now() - started, removedEnvironmentKeys: environment.removed }));
      };
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      const append = (which: "stdout" | "stderr", chunk: Buffer) => { const next = (which === "stdout" ? stdout : stderr) + chunk.toString("utf8"); if (Buffer.byteLength(next, "utf8") > maxOutput) { overflow = true; child.kill("SIGKILL"); return; } if (which === "stdout") stdout = next; else stderr = next; };
      child.on("spawn", () => { spawned = true; }); child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk)); child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("error", (error) => { stderr += `\n${error.message}`; finish(null); }); child.on("close", (code) => finish(code));
      child.stdin?.end(input.plan.stdin);
    });
  }
}
