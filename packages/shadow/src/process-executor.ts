import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { BrainGateInvariantError, type RegisteredProject } from "@braingate/core";
import { SecretGuard, redactSecrets } from "@braingate/security";
import { CODEX_STAGE_TOKEN } from "./codex-isolation.js";
import type { ShadowInvocationPlan, ShadowProcessExecutor, ShadowProcessResult } from "./types.js";

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function assertShadowProjectCwd(project: RegisteredProject, cwdInput: string): string {
  let cwd: string;
  try { cwd = realpathSync.native(resolve(cwdInput)); }
  catch { throw new BrainGateInvariantError("SHADOW_CWD_INVALID", "Shadow working directory does not exist or cannot be resolved."); }
  const approved = project.repositories.some((repository) => {
    try { return inside(realpathSync.native(repository), cwd); }
    catch { return false; }
  });
  if (!approved) throw new BrainGateInvariantError("SHADOW_CWD_ESCAPE", "Shadow working directory is outside the registered project repositories.");
  return cwd;
}

export class NodeShadowProcessExecutor implements ShadowProcessExecutor {
  readonly #secretGuard = new SecretGuard();

  async run(input: {
    readonly project: RegisteredProject;
    readonly plan: ShadowInvocationPlan;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }): Promise<ShadowProcessResult> {
    const sourceCwd = assertShadowProjectCwd(input.project, input.plan.cwd);
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 180_000, 1_000), 10 * 60_000);
    const maxOutput = Math.min(Math.max(input.maxOutputBytes ?? 1024 * 1024, 8 * 1024), 8 * 1024 * 1024);
    const baseEnv = input.env ?? process.env;
    let tempRoot: string | null = null;
    let spawnCwd = sourceCwd;
    let args = [...input.plan.args];
    const overrides: Record<string, string> = { ...input.plan.envOverrides };
    const internalAllowedEnv = new Set(input.plan.allowedEnvKeys);

    try {
      if (input.plan.workspaceMode === "staged-clean") {
        tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "braingate-shadow-stage-")));
        spawnCwd = join(tempRoot, "workspace");
        const isolatedHome = join(tempRoot, "home");
        mkdirSync(spawnCwd, { mode: 0o700 });
        mkdirSync(isolatedHome, { mode: 0o700 });

        if (input.plan.providerId === "openai") {
          // The caller may intentionally pass a minimal child environment. Resolve only the
          // location of the existing auth home from the request first, then BrainGate's host
          // environment. No auth file is read or copied, and the child environment is still
          // rebuilt through SecretGuard below.
          const hostHome = baseEnv.HOME ?? process.env.HOME;
          const originalCodexHome = baseEnv.CODEX_HOME ?? process.env.CODEX_HOME ?? (hostHome === undefined ? null : join(hostHome, ".codex"));
          if (originalCodexHome === null) {
            throw new BrainGateInvariantError("SHADOW_CODEX_HOME_UNKNOWN", "Codex authentication home cannot be located without CODEX_HOME or HOME.");
          }
          // CODEX_HOME is an executor-owned requirement for this hardened path, not a caller-granted
          // arbitrary environment capability. HOME itself is already in SecretGuard's base safe set.
          internalAllowedEnv.add("CODEX_HOME");
          overrides.CODEX_HOME = originalCodexHome;
          overrides.HOME = isolatedHome;
        }

        args = args.map((argument) => argument.replaceAll(CODEX_STAGE_TOKEN, spawnCwd));
        if (args.some((argument) => argument.includes(CODEX_STAGE_TOKEN))) {
          throw new BrainGateInvariantError("SHADOW_STAGE_TOKEN_INVALID", "Staged shadow invocation contains an unresolved workspace token.");
        }
      } else if (args.some((argument) => argument.includes(CODEX_STAGE_TOKEN))) {
        throw new BrainGateInvariantError("SHADOW_STAGE_TOKEN_INVALID", "Project-mode shadow invocation cannot contain a staged workspace token.");
      }

      if (input.plan.inputMode === "temp-attachment") {
        if (input.plan.attachmentContent === null || input.plan.attachmentToken === null) {
          throw new BrainGateInvariantError("SHADOW_ATTACHMENT_INVALID", "Attachment-mode plan requires attachment content and token.");
        }
        if (tempRoot !== null) throw new BrainGateInvariantError("SHADOW_STAGE_ATTACHMENT_CONFLICT", "Staged workspace and attachment modes cannot share a temporary root.");
        tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "braingate-shadow-")));
        const attachmentPath = join(tempRoot, "input.json");
        writeFileSync(attachmentPath, input.plan.attachmentContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
        const configHome = join(tempRoot, "copilot-home");
        mkdirSync(configHome, { mode: 0o700 });
        overrides.COPILOT_HOME = configHome;
        args = args.map((argument) => argument === input.plan.attachmentToken ? attachmentPath : argument);
      }

      const environment = this.#secretGuard.buildEnvironment(baseEnv, {
        allowedAdditionalKeys: [...internalAllowedEnv],
        overrides,
      });
      const started = Date.now();
      return await new Promise<ShadowProcessResult>((resolveResult) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let overflow = false;
        let spawned = false;
        let settled = false;
        const child = spawn(input.plan.executable, args, { cwd: spawnCwd, env: environment.env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveResult(Object.freeze({ spawned, exitCode: overflow ? null : exitCode, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), timedOut: timedOut || overflow, durationMs: Date.now() - started, removedEnvironmentKeys: environment.removed }));
        };
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
        const append = (target: "stdout" | "stderr", chunk: Buffer) => {
          const current = target === "stdout" ? stdout : stderr;
          const next = current + chunk.toString("utf8");
          if (Buffer.byteLength(next, "utf8") > maxOutput) { overflow = true; child.kill("SIGKILL"); return; }
          if (target === "stdout") stdout = next; else stderr = next;
        };
        child.on("spawn", () => { spawned = true; });
        child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
        child.on("error", (error) => { stderr += `\n${error.message}`; finish(null); });
        child.on("close", (exitCode) => finish(exitCode));
        if (input.plan.stdin !== null) child.stdin?.end(input.plan.stdin); else child.stdin?.end();
      });
    } finally {
      if (tempRoot !== null) rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
