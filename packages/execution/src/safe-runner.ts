import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { BrainGateInvariantError, type RegisteredProject } from "@braingate/core";
import { SecretGuard, redactSecrets } from "@braingate/security";
import type { WorktreeHandle } from "./worktree-guard.js";

export type ExecutionProfile = "read-only" | "worktree-write" | "verify";
export interface StructuredCommand { readonly executable: string; readonly args: readonly string[]; readonly cwd: string; }
export interface CommandResult { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean; readonly removedEnvironmentKeys: readonly string[]; }

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const READ_GIT = new Set(["status", "diff", "log", "show", "ls-files", "grep", "rev-parse"]);

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function key(command: Pick<StructuredCommand, "executable" | "args">): string {
  return JSON.stringify([basename(command.executable).toLowerCase(), ...command.args]);
}

export class SafeCommandRunner {
  readonly #secretGuard = new SecretGuard();
  readonly #verification = new Set<string>();

  constructor(verificationCommands: readonly { executable: string; args: readonly string[] }[] = []) {
    for (const command of verificationCommands) this.#verification.add(key(command));
  }

  async run(input: {
    project: RegisteredProject;
    profile: ExecutionProfile;
    command: StructuredCommand;
    worktree?: WorktreeHandle;
    env?: NodeJS.ProcessEnv;
    allowedEnvKeys?: readonly string[];
    timeoutMs?: number;
    maxOutputBytes?: number;
  }): Promise<CommandResult> {
    const executable = basename(input.command.executable).toLowerCase();
    if (SHELLS.has(executable)) throw new BrainGateInvariantError("COMMAND_SHELL_DENIED", "Shell interpreters are not allowed by SafeCommandRunner.");
    if (input.command.args.some((arg) => arg.includes("\0"))) throw new BrainGateInvariantError("COMMAND_ARG_INVALID", "NUL bytes are forbidden in command arguments.");

    let root: string;
    if (input.profile === "read-only") {
      const cwd = resolve(input.command.cwd);
      const repo = input.project.repositories.find((candidate) => inside(candidate, cwd));
      if (repo === undefined) throw new BrainGateInvariantError("COMMAND_CWD_DENIED", "Read-only command cwd is outside the registered project repositories.");
      root = repo;
      if (executable !== "git" || input.command.args.length === 0 || !READ_GIT.has(input.command.args[0]!)) {
        throw new BrainGateInvariantError("COMMAND_READ_ONLY_DENIED", "Read-only execution currently permits only a restricted set of git inspection commands.");
      }
    } else {
      const worktree = input.worktree;
      if (worktree === undefined || worktree.projectId !== input.project.projectId) throw new BrainGateInvariantError("COMMAND_WORKTREE_REQUIRED", "This profile requires a project worktree handle.");
      root = worktree.worktreePath;
      const cwd = resolve(input.command.cwd);
      if (!inside(root, cwd)) throw new BrainGateInvariantError("COMMAND_CWD_DENIED", "Command cwd escapes the task worktree.");
      if (input.profile === "worktree-write") {
        throw new BrainGateInvariantError("COMMAND_WRITE_ISOLATION_REQUIRED", "Untrusted write-capable processes remain blocked until an isolation backend is attached.");
      }
      if (!this.#verification.has(key(input.command))) throw new BrainGateInvariantError("COMMAND_VERIFY_DENIED", "Verification command is not declared in project policy.");
    }

    const cwd = resolve(input.command.cwd);
    if (!inside(root, cwd)) throw new BrainGateInvariantError("COMMAND_CWD_DENIED", "Command cwd escapes its execution root.");
    const environment = this.#secretGuard.buildEnvironment(input.env ?? process.env, { allowedAdditionalKeys: input.allowedEnvKeys });
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 60_000, 100), 15 * 60_000);
    const maxOutput = Math.min(Math.max(input.maxOutputBytes ?? 512 * 1024, 1024), 8 * 1024 * 1024);

    return await new Promise<CommandResult>((resolveResult) => {
      let stdout = ""; let stderr = ""; let timedOut = false; let overflow = false;
      const child = spawn(input.command.executable, [...input.command.args], { cwd, env: environment.env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      const append = (which: "stdout" | "stderr", chunk: Buffer) => {
        const next = (which === "stdout" ? stdout : stderr) + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > maxOutput) { overflow = true; child.kill("SIGKILL"); return; }
        if (which === "stdout") stdout = next; else stderr = next;
      };
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk)); child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("error", (error) => { stderr += `\n${error.message}`; });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolveResult({ exitCode: overflow ? null : exitCode, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), timedOut: timedOut || overflow, removedEnvironmentKeys: environment.removed });
      });
    });
  }
}
