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

export function planClaudeWriteInvocation(input: { readonly snapshot: ProviderSnapshot; readonly model: ModelRef; readonly cwd: string; readonly task: string; readonly context: unknown; readonly findings?: readonly string[]; readonly candidateOutput?: string | null; readonly maxTurns?: number }): WriteProviderPlan {
  assertClaudeWriteEligible(input.snapshot, input.model);
  const body = JSON.stringify(Object.freeze({
    schemaVersion: 1,
    task: input.task,
    context: input.context,
    findings: Object.freeze([...(input.findings ?? [])]),
    candidateOutput: input.candidateOutput ?? null,
    constraints: Object.freeze({ smallChangeOnly: true, worktreeOnly: true, noShell: true, noNetwork: true, noSecrets: true, noAgentConfigChanges: true }),
    responseContract: WRITE_SCHEMA,
  }));
  if (body.length === 0 || body.length > 2_000_000) throw new BrainGateInvariantError("WRITE_PAYLOAD_INVALID", "Write payload must be between 1 and 2,000,000 characters.");
  // A ceiling on pathology, not a budget: see ExecutionBudget.maxInspectionTurns. Clamping
  // lower than the budget asks for would silently reimpose the limit this stopped being.
  const maxTurns = Math.max(1, Math.min(60, Math.floor(input.maxTurns ?? 20)));
  const args = Object.freeze([
    "--restricted",
    "--safe-mode",
    "-p", GENERIC_WRITE_PROMPT,
    "--output-format", "json",
    "--json-schema", JSON.stringify(WRITE_SCHEMA),
    "--no-session-persistence",
    "--no-chrome",
    "--disable-slash-commands",
    "--permission-mode", "acceptEdits",
    "--tools", "Read,Glob,Grep,Edit,Write",
    // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, which this profile sets, makes Claude Code force
    // permission mode back to default, so --permission-mode alone leaves every Edit awaiting
    // an approval that never comes in a headless run and the task ends with no changes. The
    // CLI's own guidance is to declare the allowlist explicitly, which is narrower than a
    // permission mode: exactly these five tools, still under the deny list in --settings.
    "--allowedTools", "Read,Glob,Grep,Edit,Write",
    "--disallowedTools", "Bash,WebFetch,WebSearch,Agent,NotebookEdit,mcp__*",
    "--strict-mcp-config",
    "--mcp-config", "{\"mcpServers\":{}}",
    "--settings", JSON.stringify(SETTINGS),
    "--max-turns", String(maxTurns),
    "--model", input.model.modelId,
  ]);
  if (args.some((arg) => /dangerously-skip|allow-dangerously|--bare|--worktree|--add-dir/.test(arg))) throw new BrainGateInvariantError("WRITE_PROFILE_UNSAFE", "Unsafe Claude write profile flag detected.");
  return Object.freeze({
    providerId: "anthropic",
    grant: resolveToolGrant({
      role: "primary", providerId: "anthropic", workspaceMode: "task-worktree", writeMode: true,
      // Claude's boundary here is its settings file and its tool allowlist, not the kernel —
      // which is enough to withhold a shell and not enough to grant one.
      surface: { isolatedPerInvocation: true, toolDenial: true, declaredSubagents: true, enforcedSandbox: false },
      attested: true, operatorAccepted: false,
    }),
    executable: input.snapshot.binary,
    args,
    cwd: input.cwd,
    modelId: input.model.modelId,
    quotaPool: input.model.quotaPool,
    stdin: body,
    allowedEnvKeys: Object.freeze(["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_SKIP_PROMPT_HISTORY", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"]),
    envOverrides: Object.freeze({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" }),
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
