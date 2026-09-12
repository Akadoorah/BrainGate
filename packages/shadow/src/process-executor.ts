import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { BrainGateInvariantError, type RegisteredProject } from "@braingate/core";
import { SecretGuard, redactSecrets } from "@braingate/security";
import { GROK_SNAPSHOT_READ_SANDBOX, createIsolatedGrokHome, grokSandboxProfileToml, resolveGrokHome } from "./grok-isolation.js";
import { trackChild } from "./child-registry.js";
import { DEFAULT_PROVIDER_CALL_MS, MAX_PROVIDER_CALL_MS } from "./limits.js";
import { ContractTextStream, LineBuffer, ProviderStreamReader } from "./streaming.js";
import { STAGE_PATH_TOKEN, type ShadowInvocationPlan, type ShadowProcessExecutor, type ShadowProcessResult } from "./types.js";

/** How much of a failed run's own words are kept for diagnosis, on top of the retained lines. */
const FAILURE_TAIL_CHARS = 4_000;
const FAILURE_TAIL_LINES = 50;

/**
 * Runs a display callback without letting it end the run.
 *
 * The terminal is downstream of the work. A drawing routine that throws must not discard a
 * provider's answer.
 */
function safely(action: () => void): void {
  try { action(); } catch { /* the display is not the work */ }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function assertShadowProjectCwd(project: RegisteredProject, cwdInput: string): string {
  let cwd: string;
  try { cwd = realpathSync.native(resolve(cwdInput)); }
  catch { throw new BrainGateInvariantError("SHADOW_CWD_INVALID", "Shadow working directory does not exist or cannot be resolved."); }
  // A registered repository, or a task worktree BrainGate made for this project.
  //
  // The worktree was missing, and it is where a write task's work actually happens: a pass that
  // produces an artifact runs against the worktree, not the checkout, and was refused for being
  // "outside the project" when it was the one place it was supposed to be. Worktrees live under
  // the project's own private storage directory, so this widens the boundary to a directory
  // BrainGate created, not to the filesystem.
  // Two directories BrainGate created for its own runs are approved as working directories: task
  // worktrees, and the project snapshots a read-primary run is pointed at. Neither is the operator's
  // checkout, and both are deleted when the task reaches a terminal path.
  const roots = [...project.repositories, join(project.storageDir, "worktrees"), join(project.storageDir, "snapshots")];
  const approved = roots.some((root) => {
    try { return inside(realpathSync.native(root), cwd); }
    catch { return false; }
  });
  if (!approved) throw new BrainGateInvariantError("SHADOW_CWD_ESCAPE", "Shadow working directory is outside the registered project repositories and BrainGate's own task worktrees.");
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
    readonly onText?: (text: string) => void;
    readonly onThinking?: () => void;
  }): Promise<ShadowProcessResult> {
    if (input.plan.preview === true) {
      throw new BrainGateInvariantError("SHADOW_PREVIEW_NOT_EXECUTABLE", "A preview invocation states what a run would do; it is not a run.");
    }
    const sourceCwd = assertShadowProjectCwd(input.project, input.plan.cwd);
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_PROVIDER_CALL_MS, 1_000), MAX_PROVIDER_CALL_MS);
    const maxOutput = Math.min(Math.max(input.maxOutputBytes ?? 1024 * 1024, 8 * 1024), 8 * 1024 * 1024);
    const baseEnv = input.env ?? process.env;
    let tempRoot: string | null = null;
    let spawnCwd = sourceCwd;
    let args = [...input.plan.args];
    const overrides: Record<string, string> = { ...input.plan.envOverrides };
    const internalAllowedEnv = new Set(input.plan.allowedEnvKeys);

    try {
      if (input.plan.workspaceMode === "staged-clean" || input.plan.workspaceMode === "staged-read-snapshot") {
        // Both modes need an isolated home; only the staged one needs a workspace built here. The
        // snapshot is prepared before the call and handed in, so it is verified (and reused across a
        // failover's attempts) rather than quietly rebuilt per attempt.
        tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "braingate-shadow-stage-")));
        const isolatedHome = join(tempRoot, "home");
        if (input.plan.workspaceMode === "staged-read-snapshot") {
          if (input.plan.workspaceRoot === undefined) {
            throw new BrainGateInvariantError("SHADOW_SNAPSHOT_ROOT_REQUIRED", "A snapshot-primary run requires the prepared workspace it must read.");
          }
          spawnCwd = realpathSync.native(input.plan.workspaceRoot);
          assertShadowProjectCwd(input.project, spawnCwd);
          if (!statSync(spawnCwd).isDirectory()) throw new BrainGateInvariantError("SHADOW_SNAPSHOT_ROOT_REQUIRED", "The snapshot workspace is not a directory.");
        } else {
          spawnCwd = join(tempRoot, "workspace");
          mkdirSync(spawnCwd, { mode: 0o700 });
        }
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

        if (input.plan.providerId === "xai") {
          // The sandbox profile has to live where Grok looks for a project profile: inside the
          // workspace it is being pointed at. Writing it here rather than into the operator's
          // own sandbox.toml means BrainGate never edits their Grok configuration, and the
          // profile disappears with the stage.
          //
          // A read-primary run on a project copy uses the snapshot-read profile and executes from a
          // BrainGate-created home: the operator's Grok home carries their installed plugins and hook
          // configuration, and a plugin is an arbitrary process that would otherwise be inside the
          // sandbox with a copy of the project's source. A staged role keeps the operator's home,
          // because that is the posture its own attestation was earned under.
          const snapshotRead = input.plan.workspaceMode === "staged-read-snapshot";
          mkdirSync(join(spawnCwd, ".grok"), { mode: 0o700 });
          writeFileSync(
            join(spawnCwd, ".grok", "sandbox.toml"),
            snapshotRead ? GROK_SNAPSHOT_READ_SANDBOX.toml : grokSandboxProfileToml(),
            { encoding: "utf8", mode: 0o600, flag: "wx" },
          );
          // Same shape as Codex: an isolated HOME so the run cannot see another tool's
          // settings file, and the provider's own home variable so authentication survives.
          internalAllowedEnv.add("GROK_HOME");
          const operatorGrokHome = resolveGrokHome(baseEnv.GROK_HOME === undefined && baseEnv.HOME === undefined ? process.env : baseEnv);
          if (snapshotRead) {
            const isolatedGrokHome = createIsolatedGrokHome({ root: tempRoot, realHome: operatorGrokHome });
            if (!isolatedGrokHome.credentialReferenced) {
              throw new BrainGateInvariantError("SHADOW_GROK_CREDENTIAL_MISSING", `Grok's credential was not found where the isolated home could reference it (${join(operatorGrokHome, "auth.json")}).`);
            }
            overrides.GROK_HOME = isolatedGrokHome.home;
          } else {
            overrides.GROK_HOME = operatorGrokHome;
          }
          overrides.HOME = isolatedHome;
        }

        for (const [name, content] of Object.entries(input.plan.stagedFiles ?? {})) {
          if (name.includes("/") || name.includes("\\") || name.includes("..") || name.length === 0) {
            throw new BrainGateInvariantError("SHADOW_STAGED_FILE_INVALID", "A staged file name must be a plain file name inside the workspace.");
          }
          writeFileSync(join(spawnCwd, name), content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        }

        if (input.plan.inputMode === "staged-file") {
          if (input.plan.attachmentContent === null || input.plan.attachmentToken === null) {
            throw new BrainGateInvariantError("SHADOW_ATTACHMENT_INVALID", "Staged-file plan requires request content and a file name.");
          }
          if (input.plan.attachmentToken.includes("/") || input.plan.attachmentToken.includes("\\") || input.plan.attachmentToken.includes("..")) {
            throw new BrainGateInvariantError("SHADOW_ATTACHMENT_INVALID", "Staged request file name must be a plain file name inside the workspace.");
          }
          writeFileSync(join(spawnCwd, input.plan.attachmentToken), input.plan.attachmentContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
        }

        args = args.map((argument) => argument.replaceAll(STAGE_PATH_TOKEN, spawnCwd));
        if (args.some((argument) => argument.includes(STAGE_PATH_TOKEN))) {
          throw new BrainGateInvariantError("SHADOW_STAGE_TOKEN_INVALID", "Staged shadow invocation contains an unresolved workspace token.");
        }
      } else if (args.some((argument) => argument.includes(STAGE_PATH_TOKEN))) {
        throw new BrainGateInvariantError("SHADOW_STAGE_TOKEN_INVALID", "Project-mode shadow invocation cannot contain a staged workspace token.");
      }

      if (Object.keys(input.plan.stagedFiles ?? {}).length > 0 && input.plan.workspaceMode === "project") {
        throw new BrainGateInvariantError("SHADOW_STAGED_FILE_INVALID", "Staged files have nowhere to go outside a staged workspace.");
      }

      if (input.plan.inputMode === "staged-file" && input.plan.workspaceMode === "project") {
        throw new BrainGateInvariantError("SHADOW_ATTACHMENT_INVALID", "A staged request file has nowhere to go outside a staged workspace.");
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
        // What the run said last, kept only for a failed run's diagnosis.
        //
        // A streamed provider's output is deliberately thinned on the way in — the deltas carry
        // the answer and are dropped — so a failure would otherwise leave nothing of the CLI's own
        // words to read. This bounded ring is the exception: raw lines, last fifty or four
        // kilobytes, used only when something goes wrong.
        const tail: string[] = [];
        let tailChars = 0;
        const remember = (line: string): void => {
          tail.push(line);
          tailChars += line.length;
          while (tail.length > FAILURE_TAIL_LINES || (tailChars > FAILURE_TAIL_CHARS && tail.length > 1)) {
            tailChars -= tail.shift()!.length;
          }
        };
        const child = spawn(input.plan.executable, args, { cwd: spawnCwd, env: environment.env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        // Registered so a termination signal reaches a provider that a terminal Ctrl-C would not:
        // a signal sent to BrainGate alone leaves the child spending a subscription unrecorded.
        const untrack = trackChild(child);
        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          untrack();
          if (dialect !== null) {
            const rest = lines.flush();
            if (rest.trim().length > 0) consume(rest);
          }
          const stdoutTail = dialect === null ? stdout.slice(-FAILURE_TAIL_CHARS) : tail.join("\n");
          resolveResult(Object.freeze({
            spawned,
            exitCode: overflow ? null : exitCode,
            stdout: redactSecrets(stdout),
            stderr: redactSecrets(stderr),
            stdoutTail: redactSecrets(stdoutTail),
            assembled: dialect === null || assembled.length === 0 ? null : redactSecrets(assembled),
            timedOut: timedOut || overflow,
            durationMs: Date.now() - started,
            removedEnvironmentKeys: environment.removed,
          }));
        };
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
        // A streamed run is read line by line: the answer is assembled from its pieces, the
        // prose inside it is forwarded as it arrives, and only the lines the final parse
        // actually needs are retained. Without that last part a token stream spends the whole
        // output cap on thinking and signature deltas nobody reads.
        const dialect = input.plan.streamDialect;
        const reader = dialect === null ? null : new ProviderStreamReader(dialect);
        const lines = new LineBuffer();
        let prose = new ContractTextStream();
        let assembled = "";
        let announcedThinking = false;
        /**
         * Whether this provider is streaming the contract's JSON or the prose itself.
         *
         * Measured: given a schema, Claude fills it through a `StructuredOutput` tool and streams
         * the human answer as text, while Grok streams the schema-constrained JSON directly. So
         * the first character of the answer decides which one this is, and guessing wrong either
         * shows JSON to a person or shows them nothing at all.
         */
        let shape: "unknown" | "contract-json" | "prose" = "unknown";

        const consume = (line: string): void => {
          remember(line);
          const verdict = reader!.read(line);
          if (verdict.restart === true && assembled.length > 0) {
            // A fresh block is a fresh answer. The prose reader starts again with it, so a
            // narrated run does not stream the same field twice.
            assembled = "";
            prose = new ContractTextStream();
            shape = "unknown";
          }
          if (verdict.retain) {
            const next = `${stdout}${line}\n`;
            if (Buffer.byteLength(next, "utf8") > maxOutput) { overflow = true; child.kill("SIGKILL"); return; }
            stdout = next;
          }
          if (verdict.thinking && !announcedThinking) { announcedThinking = true; safely(() => input.onThinking?.()); }
          if (verdict.answer === null) return;
          assembled += verdict.answer;
          if (Buffer.byteLength(assembled, "utf8") > maxOutput) { overflow = true; child.kill("SIGKILL"); return; }
          if (shape === "unknown") {
            const leading = assembled.trimStart();
            if (leading.length > 0) shape = leading.startsWith("{") ? "contract-json" : "prose";
          }
          if (shape === "prose") { safely(() => input.onText?.(verdict.answer!)); return; }
          if (shape === "contract-json") {
            const readable = prose.push(verdict.answer);
            if (readable.length > 0) safely(() => input.onText?.(readable));
          }
        };

        const append = (target: "stdout" | "stderr", chunk: Buffer) => {
          if (target === "stdout" && dialect !== null) {
            for (const line of lines.take(chunk.toString("utf8"))) consume(line);
            return;
          }
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
