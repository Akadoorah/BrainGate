import { spawn } from "node:child_process";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { BrainGateInvariantError } from "@braingate/core";
import type { ProbeCommand, ProbeResult, ProbeRunner } from "./types.js";

export const SUBSCRIPTION_BILLING_OVERRIDE_ENV = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "XAI_API_KEY",
  "COPILOT_PROVIDER_API_KEY",
  "COPILOT_PROVIDER_BASE_URL",
  "COPILOT_PROVIDER_TYPE",
] as const);

const SAFE_PROBE_COMMANDS = new Set([
  "claude\0--version",
  "claude\0--help",
  "claude\0auth\0status",
  "codex\0--version",
  "codex\0--help",
  // Codex keeps its execution flags under the subcommand: `codex --help` never mentions
  // `--output-schema`. Reading only the top level would record a surface this build has as one
  // it lacks, which is the drift the capability report exists to stop.
  "codex\0exec\0--help",
  "codex\0login\0status",
  "agy\0--version",
  "agy\0--help",
  "agy\0models",
  "grok\0version",
  "grok\0--help",
  "grok\0models",
  // `copilot version` is refused by copilot 0.0.358 ("Invalid command format"); `--version` is the
  // form that answers. Found by the real Arabic dogfood run, which the allowlist stopped at the
  // first probe: the discovery test's fake runner cannot see this list.
  "copilot\0--version",
  "copilot\0help",
]);

const MAX_CAPTURE_BYTES = 256 * 1024;

function normalizedBinary(binary: string): string {
  const name = basename(binary).toLowerCase();
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

function commandKey(command: ProbeCommand): string {
  return [normalizedBinary(command.binary), ...command.args].join("\0");
}

export function formatProbeCommand(command: ProbeCommand): string {
  return [normalizedBinary(command.binary), ...command.args].join(" ");
}

export function assertSafeProbeCommand(command: ProbeCommand): void {
  if (!SAFE_PROBE_COMMANDS.has(commandKey(command))) {
    throw new BrainGateInvariantError(
      "PROVIDER_PROBE_UNSAFE",
      `Provider discovery refused non-whitelisted command: ${formatProbeCommand(command)}`,
    );
  }
}

export function sanitizeSubscriptionEnvironment(base: NodeJS.ProcessEnv = process.env): {
  readonly env: NodeJS.ProcessEnv;
  readonly removed: readonly string[];
} {
  const env: NodeJS.ProcessEnv = { ...base };
  const removed: string[] = [];
  for (const key of SUBSCRIPTION_BILLING_OVERRIDE_ENV) {
    if (env[key] !== undefined) {
      removed.push(key);
      delete env[key];
    }
  }

  // Metadata probes must not become interactive model sessions.
  env.CI = "1";
  env.NO_COLOR = "1";
  env.TERM = "dumb";

  return { env, removed: Object.freeze(removed.sort()) };
}

export class NodeProbeRunner implements ProbeRunner {
  readonly #cwd: string;
  readonly #baseEnv: NodeJS.ProcessEnv;

  constructor(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.#cwd = options.cwd ?? tmpdir();
    this.#baseEnv = options.env ?? process.env;
  }

  async run(command: ProbeCommand): Promise<ProbeResult> {
    assertSafeProbeCommand(command);
    const sanitized = sanitizeSubscriptionEnvironment(this.#baseEnv);
    const timeoutMs = command.timeoutMs ?? 5_000;
    const observedAt = new Date().toISOString();

    return await new Promise<ProbeResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let outputExceeded = false;
      let spawned = false;
      let errorCode: string | null = null;

      const child = spawn(command.binary, [...command.args], {
        cwd: this.#cwd,
        env: sanitized.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        const next = (target === "stdout" ? stdout : stderr) + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > MAX_CAPTURE_BYTES) {
          outputExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        if (target === "stdout") stdout = next;
        else stderr = next;
      };

      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("spawn", () => { spawned = true; });
      child.on("error", (error: NodeJS.ErrnoException) => { errorCode = error.code ?? "SPAWN_ERROR"; });
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          command,
          spawned,
          exitCode,
          stdout,
          stderr,
          timedOut,
          errorCode: outputExceeded ? "OUTPUT_LIMIT" : errorCode,
          observedAt,
          removedBillingOverrides: sanitized.removed,
        });
      });
    });
  }
}
