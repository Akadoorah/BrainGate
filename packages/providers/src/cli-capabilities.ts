import type { ProbeCommand, ProbeResult, ProbeRunner, ProviderId } from "./types.js";
import { formatProbeCommand } from "./probe-runner.js";

/**
 * The execution surfaces BrainGate cares about, as one list the type is derived from.
 *
 * These are not the provider *capabilities* discovery already reports (headless, model pinning,
 * structured output). Those answer "can this CLI be driven at all". These answer "what may a
 * profile ask this build to do" — the questions Milestones 14-18 need answered before they can
 * widen a role, and the questions that today are answered by constants somebody typed by hand.
 */
export const CLI_FEATURES = [
  "structuredSchema",
  "stdinPrompt",
  "promptFile",
  "declaredSubagents",
  "directoryScoping",
  "sandbox",
  "worktree",
  "toolDenial",
  "sessionResume",
  "nativeReview",
] as const;
export type CliFeature = (typeof CLI_FEATURES)[number];

export function isCliFeature(value: string): value is CliFeature {
  return (CLI_FEATURES as readonly string[]).includes(value);
}

/**
 * One measured answer.
 *
 * `supported` is `"unknown"` rather than `false` when the help text could not be read at all.
 * The distinction is the whole point: a feature this build does not have and a feature nobody
 * looked for are different facts, and treating the second as the first is how a stale limitation
 * outlives the release that fixed it.
 */
export interface CliFeatureObservation {
  readonly supported: boolean | "unknown";
  /** The flag or subcommand that matched, so a reader can check the claim without rerunning. */
  readonly evidence: string | null;
}

export interface CliCapabilityReport {
  readonly providerId: ProviderId;
  readonly binary: string;
  readonly version: string | null;
  readonly observedAt: string;
  /** Every help command consulted, so the measurement can be reproduced exactly. */
  readonly sourceCommands: readonly string[];
  readonly features: Readonly<Record<CliFeature, CliFeatureObservation>>;
}

interface FeatureMatcher {
  readonly feature: CliFeature;
  /** Matched against the combined help output; the first hit becomes the evidence. */
  readonly patterns: readonly RegExp[];
}

interface CliSpec {
  readonly binary: string;
  /**
   * Help commands to read, in order.
   *
   * More than one because a flag can live under a subcommand: `codex --help` does not mention
   * `--output-schema`, and reading only the top level would record a schema surface this build
   * has as one it lacks.
   */
  readonly helpCommands: readonly (readonly string[])[];
  readonly matchers: readonly FeatureMatcher[];
}

function matcher(feature: CliFeature, ...patterns: readonly RegExp[]): FeatureMatcher {
  return { feature, patterns };
}

const SPECS: Readonly<Record<ProviderId, CliSpec>> = Object.freeze({
  anthropic: {
    binary: "claude",
    helpCommands: [["--help"]],
    matchers: [
      matcher("structuredSchema", /--json-schema\b/),
      matcher("stdinPrompt", /--input-format\b/),
      matcher("promptFile", /--file\b/),
      matcher("declaredSubagents", /--agents\b/, /--agent\b/),
      matcher("directoryScoping", /--add-dir\b/),
      matcher("sandbox", /--permission-mode\b/, /--restricted\b/),
      matcher("worktree", /--worktree\b/),
      matcher("toolDenial", /--disallowed-tools\b/, /--tools\b/),
      matcher("sessionResume", /--resume\b/, /--continue\b/),
      matcher("nativeReview"),
    ],
  },
  openai: {
    binary: "codex",
    helpCommands: [["--help"], ["exec", "--help"]],
    matchers: [
      matcher("structuredSchema", /--output-schema\b/),
      matcher("stdinPrompt", /read from stdin/i),
      matcher("promptFile"),
      matcher("declaredSubagents", /\bfork\b/),
      matcher("directoryScoping", /--add-dir\b/, /--cd\b/),
      matcher("sandbox", /--sandbox\b/),
      matcher("worktree"),
      matcher("toolDenial", /--disable\b/, /--ignore-rules\b/),
      matcher("sessionResume", /\bresume\b/),
      matcher("nativeReview", /\breview\b/),
    ],
  },
  google: {
    binary: "agy",
    helpCommands: [["--help"]],
    matchers: [
      matcher("structuredSchema", /--json-schema\b/),
      matcher("stdinPrompt", /stream-json reads/i, /--input-format\b/),
      matcher("promptFile"),
      matcher("declaredSubagents", /--agent\b/),
      matcher("directoryScoping", /--add-dir\b/),
      matcher("sandbox", /--sandbox\b/),
      matcher("worktree"),
      matcher("toolDenial", /--disable-slash-commands\b/),
      matcher("sessionResume", /--continue\b/, /--conversation\b/),
      matcher("nativeReview"),
    ],
  },
  xai: {
    binary: "grok",
    helpCommands: [["--help"]],
    matchers: [
      matcher("structuredSchema", /--json-schema\b/),
      matcher("stdinPrompt", /--prompt-json\b/),
      matcher("promptFile", /--prompt-file\b/),
      matcher("declaredSubagents", /--agents\b/, /--agent\b/),
      matcher("directoryScoping", /--cwd\b/),
      matcher("sandbox", /--sandbox\b/),
      matcher("worktree", /--worktree\b/),
      matcher("toolDenial", /--disallowed-tools\b/, /--deny\b/),
      matcher("sessionResume", /--resume\b/, /--continue\b/),
      matcher("nativeReview"),
    ],
  },
  "github-copilot": {
    // `copilot help` rather than `--help`: the same text, and the command discovery already
    // proved safe.
    binary: "copilot",
    helpCommands: [["help"]],
    matchers: [
      matcher("structuredSchema"),
      matcher("stdinPrompt"),
      matcher("promptFile"),
      matcher("declaredSubagents", /--agent\b/),
      matcher("directoryScoping", /--add-dir\b/),
      matcher("sandbox", /--deny-tool\b/),
      matcher("worktree"),
      matcher("toolDenial", /--deny-tool\b/, /--disable-builtin-mcps\b/),
      matcher("sessionResume", /--resume\b/, /--continue\b/),
      matcher("nativeReview"),
    ],
  },
});

/** A help text is only evidence when the command actually ran and said something. */
function usableOutput(probe: ProbeResult): string | null {
  if (!probe.spawned || probe.timedOut) return null;
  const text = `${probe.stdout}\n${probe.stderr}`;
  // Help is conventionally exit 0, but several of these CLIs exit non-zero for a bare `--help`
  // on a subcommand while still printing the text. The text is the measurement, not the code.
  return text.trim().length === 0 ? null : text;
}

function observe(matchers: FeatureMatcher[] | readonly FeatureMatcher[], feature: CliFeature, help: string | null): CliFeatureObservation {
  if (help === null) return Object.freeze({ supported: "unknown" as const, evidence: null });
  const found = matchers.find((candidate) => candidate.feature === feature);
  if (found === undefined) return Object.freeze({ supported: false as const, evidence: null });
  for (const pattern of found.patterns) {
    const hit = help.match(pattern);
    if (hit !== null) return Object.freeze({ supported: true as const, evidence: hit[0] });
  }
  return Object.freeze({ supported: false as const, evidence: null });
}

/**
 * Turns already-collected help output into a dated capability report.
 *
 * Separate from the running so the discovery path can reuse help it has already read rather
 * than spawning the same command twice.
 */
export function readCliCapabilities(input: {
  readonly providerId: ProviderId;
  readonly help: readonly ProbeResult[];
  readonly version: string | null;
  readonly observedAt: string;
}): CliCapabilityReport {
  const spec = SPECS[input.providerId];
  const texts = input.help.map(usableOutput).filter((text): text is string => text !== null);
  const combined = texts.length === 0 ? null : texts.join("\n");
  const features = Object.fromEntries(
    CLI_FEATURES.map((feature) => [feature, observe(spec.matchers, feature, combined)]),
  ) as Record<CliFeature, CliFeatureObservation>;
  return Object.freeze({
    providerId: input.providerId,
    binary: spec.binary,
    version: input.version,
    observedAt: input.observedAt,
    sourceCommands: Object.freeze(input.help.map((probe) => formatProbeCommand(probe.command))),
    features: Object.freeze(features),
  });
}

/** The help commands a full report for this provider needs. */
export function cliCapabilityProbes(providerId: ProviderId): readonly ProbeCommand[] {
  const spec = SPECS[providerId];
  return Object.freeze(spec.helpCommands.map((args) => Object.freeze({ binary: spec.binary, args: Object.freeze([...args]) })));
}

/**
 * Measures one CLI's execution surface. Reads `--help` only: no prompt, no model call, no cost.
 */
export async function probeCliCapabilities(input: {
  readonly providerId: ProviderId;
  readonly runner: ProbeRunner;
  readonly version?: string | null;
  readonly now?: () => Date;
}): Promise<CliCapabilityReport> {
  const commands = cliCapabilityProbes(input.providerId);
  const help = await Promise.all(commands.map(async (command) => input.runner.run(command)));
  return readCliCapabilities({
    providerId: input.providerId,
    help,
    version: input.version ?? null,
    observedAt: (input.now?.() ?? new Date()).toISOString(),
  });
}
