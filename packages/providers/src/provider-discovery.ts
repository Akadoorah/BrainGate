import { ModelListCache, modelCacheKey } from "./model-cache.js";
import type {
  Observation,
  ProbeCommand,
  ProbeResult,
  ProbeRunner,
  ProviderAuthMode,
  ProviderAuthState,
  ProviderCapabilities,
  ProviderId,
  ProviderSnapshot,
} from "./types.js";
import { NodeProbeRunner, formatProbeCommand } from "./probe-runner.js";

interface ProviderSpec {
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly binary: string;
  readonly versionArgs: readonly string[];
  readonly helpArgs: readonly string[];
  readonly modelArgs: readonly string[] | null;
  readonly authArgs: readonly string[] | null;
  readonly headlessPatterns: readonly RegExp[];
  readonly structuredPatterns: readonly RegExp[];
  readonly modelPatterns: readonly RegExp[];
  readonly mcpPatterns: readonly RegExp[];
}

const PROVIDERS: readonly ProviderSpec[] = Object.freeze([
  {
    providerId: "anthropic",
    displayName: "Claude Code",
    binary: "claude",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    modelArgs: null,
    authArgs: ["auth", "status"],
    headlessPatterns: [/--print\b/i, /\s-p[ ,]/i],
    structuredPatterns: [/output[- ]format/i, /json/i],
    modelPatterns: [/--model\b/i],
    mcpPatterns: [/\bmcp\b/i],
  },
  {
    providerId: "openai",
    displayName: "OpenAI Codex",
    binary: "codex",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    modelArgs: null,
    authArgs: ["login", "status"],
    headlessPatterns: [/\bexec\b/i, /non[- ]interactive/i],
    structuredPatterns: [/json/i],
    modelPatterns: [/--model\b/i, /\s-m[ ,]/i],
    mcpPatterns: [/\bmcp\b/i],
  },
  {
    providerId: "google",
    displayName: "Google Antigravity",
    binary: "agy",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    modelArgs: ["models"],
    authArgs: null,
    headlessPatterns: [/--prompt\b/i, /--print\b/i, /\s-p[ ,]/i],
    structuredPatterns: [/json/i, /stream/i],
    modelPatterns: [/--model\b/i],
    mcpPatterns: [/\bmcp\b/i],
  },
  {
    providerId: "xai",
    displayName: "Grok Build",
    binary: "grok",
    versionArgs: ["version"],
    helpArgs: ["--help"],
    modelArgs: ["models"],
    // `grok models` names the signed-in account before it lists anything, and it neither
    // prompts nor mutates. That is a zero-prompt command that reports authentication, which is
    // the bar; it was recorded as unknown only because nothing here had read its output.
    authArgs: ["models"],
    headlessPatterns: [/\s-p[ ,]/i, /headless/i],
    structuredPatterns: [/output[- ]format/i, /json/i],
    modelPatterns: [/--model\b/i, /\s-m[ ,]/i],
    mcpPatterns: [/\bmcp\b/i],
  },
  {
    providerId: "github-copilot",
    displayName: "GitHub Copilot CLI",
    binary: "copilot",
    // `copilot version` is "Invalid command format" on copilot 0.0.358; `--version` prints the
    // version and commit on the first two lines (measured 2026-09-19).
    versionArgs: ["--version"],
    helpArgs: ["help"],
    modelArgs: null,
    authArgs: null,
    headlessPatterns: [/--prompt\b/i, /\s-p[ ,]/i, /programmatic/i],
    structuredPatterns: [/output[- ]format/i, /json/i, /stream/i],
    modelPatterns: [/--model\b/i],
    mcpPatterns: [/\bmcp\b/i],
  },
]);

function observation<T>(
  value: T,
  evidence: Observation<T>["evidence"],
  sourceCommand: string | null,
  observedAt = new Date().toISOString(),
): Observation<T> {
  return { value, evidence, sourceCommand, observedAt };
}

function combinedOutput(result: ProbeResult): string {
  return `${result.stdout}\n${result.stderr}`.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function firstUsefulLine(result: ProbeResult): string | null {
  const line = combinedOutput(result)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line ?? null;
}

function capabilityFromHelp(help: ProbeResult | null, patterns: readonly RegExp[]): boolean | "unknown" {
  if (help === null || !help.spawned || help.exitCode !== 0 || help.timedOut) return "unknown";
  const output = combinedOutput(help);
  return patterns.some((pattern) => pattern.test(output));
}

function parseModels(result: ProbeResult): readonly string[] {
  const ignored = new Set(["model", "models", "id", "name", "available", "default", "slug"]);
  const models: string[] = [];
  for (const rawLine of combinedOutput(result).split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[*•>+-]\s*/, "");
    if (line.length === 0) continue;
    const candidate = line.split(/\s+/)[0]?.replace(/[,:]$/, "");
    if (candidate === undefined) continue;
    if (ignored.has(candidate.toLowerCase())) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:+/-]{1,127}$/.test(candidate)) continue;
    if (!candidate.includes("-") && !candidate.includes("/") && !candidate.includes(".")) continue;
    models.push(candidate);
  }
  return Object.freeze([...new Set(models)]);
}

function isMissingBinary(result: ProbeResult): boolean {
  return !result.spawned && (result.errorCode === "ENOENT" || result.errorCode === "UNKNOWN");
}

function mergedRemoved(...results: readonly (ProbeResult | null)[]): readonly string[] {
  return Object.freeze([...new Set(results.flatMap((result) => result?.removedBillingOverrides ?? []))].sort());
}

interface ParsedAuth {
  readonly state: ProviderAuthState;
  readonly mode: ProviderAuthMode;
  readonly evidence: Observation<ProviderAuthState>["evidence"];
}

function parseClaudeAuth(result: ProbeResult): ParsedAuth {
  if (!result.spawned || result.timedOut) return { state: "unknown", mode: "unknown", evidence: "unknown" };
  try {
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const loggedIn = parsed.loggedIn;
    if (loggedIn === false) return { state: "unauthenticated", mode: "unknown", evidence: "native" };
    if (loggedIn !== true) return { state: "unknown", mode: "unknown", evidence: "unknown" };
    const authMethod = typeof parsed.authMethod === "string" ? parsed.authMethod.toLowerCase() : "";
    const subscriptionType = typeof parsed.subscriptionType === "string" ? parsed.subscriptionType.trim() : "";
    if (subscriptionType.length > 0 && !authMethod.includes("console") && !authMethod.includes("api")) {
      return { state: "authenticated", mode: "subscription", evidence: "native" };
    }
    if (authMethod.includes("console") || authMethod.includes("api")) return { state: "authenticated", mode: "api", evidence: "native" };
    return { state: "authenticated", mode: "unknown", evidence: "native" };
  } catch {
    if (result.exitCode === 1) return { state: "unauthenticated", mode: "unknown", evidence: "native" };
    return { state: "unknown", mode: "unknown", evidence: "unknown" };
  }
}

function parseCodexAuth(result: ProbeResult): ParsedAuth {
  if (!result.spawned || result.timedOut) return { state: "unknown", mode: "unknown", evidence: "unknown" };
  const output = combinedOutput(result).trim();
  if (/Logged in using ChatGPT/i.test(output)) return { state: "authenticated", mode: "subscription", evidence: "native" };
  if (/Not logged in/i.test(output)) return { state: "unauthenticated", mode: "unknown", evidence: "native" };
  if (/Logged in using (?:an API key|access token|personal access token|Amazon Bedrock|workload identity)/i.test(output)) {
    return { state: "authenticated", mode: "api", evidence: "native" };
  }
  if (result.exitCode === 1 && output.length > 0) return { state: "unauthenticated", mode: "unknown", evidence: "native" };
  return { state: result.exitCode === 0 ? "authenticated" : "unknown", mode: "unknown", evidence: result.exitCode === 0 ? "native" : "unknown" };
}

function parseGrokAuth(result: ProbeResult): ParsedAuth {
  if (!result.spawned || result.timedOut) return { state: "unknown", mode: "unknown", evidence: "unknown" };
  const output = combinedOutput(result).trim();
  if (/not authenticated|not logged in/i.test(output)) return { state: "unauthenticated", mode: "unknown", evidence: "native" };
  // An API key is direct billing, which is the one mode BrainGate refuses outright, so it is
  // matched before the general logged-in case rather than being folded into it.
  if (/logged in with (?:an )?api key|using an api key/i.test(output)) return { state: "authenticated", mode: "api", evidence: "native" };
  if (/logged in with grok\.com|logged in as/i.test(output)) return { state: "authenticated", mode: "subscription", evidence: "native" };
  return { state: "unknown", mode: "unknown", evidence: "unknown" };
}

function parseAuth(providerId: ProviderId, result: ProbeResult): ParsedAuth {
  if (providerId === "anthropic") return parseClaudeAuth(result);
  if (providerId === "openai") return parseCodexAuth(result);
  if (providerId === "xai") return parseGrokAuth(result);
  return { state: "unknown", mode: "unknown", evidence: "unknown" };
}

export class ProviderDiscovery {
  readonly #runner: ProbeRunner;
  readonly #modelCache: ModelListCache | null;

  constructor(runner: ProbeRunner = new NodeProbeRunner(), options: { readonly modelCache?: ModelListCache } = {}) {
    this.#runner = runner;
    this.#modelCache = options.modelCache ?? null;
  }

  /**
   * Every provider, discovered at once.
   *
   * These probes are independent, read-only and mostly spent waiting on another process, and
   * running them one after another made them additive: five providers at roughly a second and a
   * half each is seven and a half seconds before a task has begun — and the interactive session
   * pays it twice, once to plan and once to run. Nothing here needs the previous provider's
   * answer, so nothing here should wait for it.
   *
   * The order of the result is the declared order, not the order they happened to finish, so a
   * snapshot list stays comparable between runs.
   */
  async discoverAll(): Promise<readonly ProviderSnapshot[]> {
    return Object.freeze(await Promise.all(PROVIDERS.map(async (spec) => await this.#discover(spec))));
  }

  async discover(providerId: ProviderId): Promise<ProviderSnapshot> {
    const spec = PROVIDERS.find((candidate) => candidate.providerId === providerId);
    if (spec === undefined) throw new Error(`Unknown provider: ${providerId}`);
    return await this.#discover(spec);
  }

  /**
   * Runs a set of probes together, spawning each distinct command exactly once.
   *
   * Two entries naming the same command share one result rather than racing: a probe is
   * read-only from BrainGate's side, but the CLI behind it may still write its own cache, and
   * two copies doing that at the same instant is a bug waiting for a slow disk.
   */
  async #runOnce(commands: readonly (ProbeCommand | null)[]): Promise<readonly (ProbeResult | null)[]> {
    const started = new Map<string, Promise<ProbeResult>>();
    return await Promise.all(commands.map(async (command) => {
      if (command === null) return null;
      const key = formatProbeCommand(command);
      const existing = started.get(key);
      if (existing !== undefined) return await existing;
      const pending = this.#runner.run(command);
      started.set(key, pending);
      return await pending;
    }));
  }

  async #discover(spec: ProviderSpec): Promise<ProviderSnapshot> {
    const versionCommand: ProbeCommand = { binary: spec.binary, args: spec.versionArgs };
    const versionResult = await this.#runner.run(versionCommand);
    const versionSource = formatProbeCommand(versionCommand);
    if (isMissingBinary(versionResult)) {
      const timestamp = versionResult.observedAt;
      return {
        providerId: spec.providerId, displayName: spec.displayName, binary: spec.binary,
        available: observation(false, "native", versionSource, timestamp),
        version: observation(null, "unknown", versionSource, timestamp),
        authState: observation("unknown", "unknown", null, timestamp),
        authMode: observation("unknown", "unknown", null, timestamp),
        models: observation(null, "unknown", null, timestamp),
        capabilities: observation({ headless: "unknown", structuredOutput: "unknown", modelPinning: "unknown", mcp: "unknown" }, "unknown", null, timestamp),
        usage: observation(null, "unknown", null, timestamp),
        removedBillingOverrides: versionResult.removedBillingOverrides,
        warnings: Object.freeze(["CLI binary not found on PATH."]),
      };
    }

    // The remaining probes do not depend on each other either, and one of them is a network
    // round trip. Identical commands are run once and shared: `grok models` reports both the
    // model list and the signed-in account, and running it twice at the same moment would also
    // have two processes writing the same model cache.
    const helpCommand: ProbeCommand = { binary: spec.binary, args: spec.helpArgs };
    const modelCommand: ProbeCommand | null = spec.modelArgs === null ? null : { binary: spec.binary, args: spec.modelArgs, timeoutMs: 7_500 };
    const authCommand: ProbeCommand | null = spec.authArgs === null ? null : { binary: spec.binary, args: spec.authArgs, timeoutMs: 5_000 };
    // Listing models is the slowest probe and the one that changes least, so a remembered list
    // is used when there is one — but never when the same command also reports authentication,
    // because a cached "signed in" that outlives a sign-out routes work to a provider that will
    // refuse it. Correctness is not traded for a second.
    const version = versionResult.exitCode === 0 && !versionResult.timedOut ? firstUsefulLine(versionResult) : null;
    const modelsAlsoReportAuth = modelCommand !== null && authCommand !== null && formatProbeCommand(modelCommand) === formatProbeCommand(authCommand);
    const cacheKey = modelCommand === null || modelsAlsoReportAuth || this.#modelCache === null
      ? null
      : modelCacheKey({ providerId: spec.providerId, version, command: formatProbeCommand(modelCommand) });
    const remembered = cacheKey === null ? null : this.#modelCache?.read(cacheKey) ?? null;

    const probes = await this.#runOnce([helpCommand, remembered === null ? modelCommand : null, authCommand]);
    const helpResult = probes[0]!;
    const modelResult = probes[1] ?? null;
    const authResult = probes[2] ?? null;
    const helpSource = formatProbeCommand(helpCommand);
    const warnings: string[] = [];

    let models: Observation<readonly string[] | null>;
    if (modelCommand !== null && remembered !== null) {
      // Still `native`: it is the provider's own answer to its own command, read back rather
      // than asked again. The timestamp is this observation, and the entry aged out on its own
      // if it were older than the window.
      models = observation(remembered, "native", formatProbeCommand(modelCommand), new Date().toISOString());
    } else if (modelCommand !== null && modelResult !== null) {
      const source = formatProbeCommand(modelCommand);
      if (modelResult.spawned && modelResult.exitCode === 0 && !modelResult.timedOut) {
        const listed = parseModels(modelResult);
        models = observation(listed, "native", source, modelResult.observedAt);
        if (cacheKey !== null) this.#modelCache?.write(cacheKey, listed);
      } else {
        models = observation(null, "unknown", source, modelResult.observedAt);
        warnings.push("Model metadata probe did not complete successfully; availability was left unknown.");
      }
    } else {
      models = observation(null, "unknown", null, helpResult.observedAt);
      warnings.push("No verified zero-prompt model-list command is configured for this provider.");
    }

    let authState: Observation<ProviderAuthState>;
    let authMode: Observation<ProviderAuthMode>;
    if (authCommand !== null && authResult !== null) {
      const source = formatProbeCommand(authCommand);
      const parsed = parseAuth(spec.providerId, authResult);
      authState = observation(parsed.state, parsed.evidence, source, authResult.observedAt);
      authMode = observation(parsed.mode, parsed.evidence, source, authResult.observedAt);
      if (parsed.state === "unknown") warnings.push("Authentication metadata probe could not be interpreted safely.");
    } else {
      authState = observation("unknown", "unknown", null, helpResult.observedAt);
      authMode = observation("unknown", "unknown", null, helpResult.observedAt);
    }

    if (version === null) warnings.push("CLI version could not be parsed from the local version command.");
    const capabilities: ProviderCapabilities = {
      headless: capabilityFromHelp(helpResult, spec.headlessPatterns),
      structuredOutput: capabilityFromHelp(helpResult, spec.structuredPatterns),
      modelPinning: capabilityFromHelp(helpResult, spec.modelPatterns),
      mcp: capabilityFromHelp(helpResult, spec.mcpPatterns),
    };
    if (spec.authArgs === null) warnings.push("Authentication and quota remain unknown unless a provider exposes them through a verified zero-prompt command; BrainGate does not open an interactive session merely to probe status.");
    else warnings.push("Quota remains unknown unless a provider exposes it through a verified zero-prompt command; BrainGate does not make a model call to probe quota.");

    return {
      providerId: spec.providerId,
      displayName: spec.displayName,
      binary: spec.binary,
      available: observation(true, "native", versionSource, versionResult.observedAt),
      version: observation(version, version === null ? "unknown" : "native", versionSource, versionResult.observedAt),
      authState, authMode, models,
      capabilities: observation(capabilities, helpResult.exitCode === 0 && !helpResult.timedOut ? "native" : "unknown", helpSource, helpResult.observedAt),
      usage: observation(null, "unknown", null, helpResult.observedAt),
      removedBillingOverrides: mergedRemoved(versionResult, helpResult, modelResult, authResult),
      warnings: Object.freeze(warnings),
    };
  }
}

export const providerIds = Object.freeze(PROVIDERS.map((provider) => provider.providerId));
