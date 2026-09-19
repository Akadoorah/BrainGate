import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * What headless Antigravity may do without a prompt, read from its own settings.
 *
 * Print-mode `agy` is fail-closed: a tool that would have prompted is auto-denied, because nobody is
 * there to answer, and the denial names the rule that would have allowed it. There is no flag that
 * passes such a rule per invocation. What there is, is the operator's own settings file, where
 * `permissions.allow` holds the rules every `agy` run on this machine honours. That file is the
 * runtime's permission model, and under DIRECT the runtime's permission model is the boundary
 * (ADR 0017) — so BrainGate reads it, never writes it, and offers Antigravity a DIRECT run exactly
 * when the operator has already decided that headless reads are allowed.
 *
 * Measured 2026-09-19 against agy 1.2.7: with no rules, a print-mode run that needs the workspace
 * ends with `denied_actions: [{"action":"command"}]` and an empty response, and its own message
 * says to add `command(<target>)` under `permissions.allow` in settings.json. The rule grammar in
 * the binary is `<tool>(<target>)`, with `read_file(*)` and `command(*)` as the two the CLI itself
 * names.
 */
export interface AntigravityHeadlessPermissions {
  /** The settings file that was consulted, so the reading can be checked by hand. */
  readonly path: string;
  /** Whether the file existed and parsed; `false` means nothing was granted and nothing was read. */
  readonly present: boolean;
  /** The `permissions.allow` rules as written, for the record. */
  readonly rules: readonly string[];
  /** A DIRECT read can open the workspace's files without a prompt. */
  readonly reads: boolean;
  /** A DIRECT run can run shell commands without a prompt. */
  readonly shell: boolean;
}

/** The rule that allows headless reads of any path. */
export const ANTIGRAVITY_READ_RULE = "read_file(*)";
/** The rule that allows headless shell commands of any kind. */
export const ANTIGRAVITY_SHELL_RULE = "command(*)";

/** Where Antigravity keeps the settings every run honours. */
export function antigravitySettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, ".gemini", "antigravity-cli", "settings.json");
}

/**
 * Whether the environment names a home to read from at all.
 *
 * The reading is taken from the environment the command was given, not from the process's own: a
 * caller that supplies an environment without HOME (every hermetic test does) gets "nothing
 * allowed", not the operator's real rules leaking in through the fallback path above.
 */
function homeNamed(env: NodeJS.ProcessEnv): boolean {
  return env.HOME !== undefined && env.HOME.length > 0;
}

function ruleTarget(rule: string, tool: string): string | null {
  const match = rule.trim().match(/^([a-z_]+)\((.*)\)$/);
  if (match === null || match[1] !== tool) return null;
  return match[2] ?? "";
}

/**
 * Whether a rule set allows a tool for the given workspace.
 *
 * `*` and `/` allow everything; a path target allows the workspace when the workspace is under it.
 * Anything narrower is not a grant a DIRECT run can rely on, so it is not counted as one.
 */
function allows(rules: readonly string[], tool: string, workspace: string | undefined): boolean {
  for (const rule of rules) {
    const target = ruleTarget(rule, tool);
    if (target === null) continue;
    if (target === "*" || target === "/") return true;
    const base = target.replace(/\/+$/, "");
    if (workspace !== undefined && base.length > 0 && (workspace === base || workspace.startsWith(`${base}/`))) return true;
  }
  return false;
}

/**
 * Reads the operator's Antigravity settings and reports what a headless run may do.
 *
 * Read-only, by contract: the file belongs to the operator and to their CLI, and a BrainGate that
 * wrote allow-rules into it would be granting itself what only the operator can grant.
 */
export function readAntigravityHeadlessPermissions(input: {
  readonly env?: NodeJS.ProcessEnv;
  /** The workspace a DIRECT run would open, for rules scoped to a path. */
  readonly workspace?: string;
  /** Test seam: the settings text, instead of the file. */
  readonly settingsText?: string | null;
} = {}): AntigravityHeadlessPermissions {
  const env = input.env ?? process.env;
  const path = antigravitySettingsPath(env);
  const text = input.settingsText !== undefined
    ? input.settingsText
    : homeNamed(env) && existsSync(path) ? readFileSync(path, "utf8") : null;
  if (text === null) return Object.freeze({ path, present: false, rules: Object.freeze([]), reads: false, shell: false });
  let rules: readonly string[] = [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const permissions = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).permissions : undefined;
    const allow = typeof permissions === "object" && permissions !== null ? (permissions as Record<string, unknown>).allow : undefined;
    rules = Array.isArray(allow) ? allow.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return Object.freeze({ path, present: false, rules: Object.freeze([]), reads: false, shell: false });
  }
  return Object.freeze({
    path,
    present: true,
    rules: Object.freeze([...rules]),
    reads: allows(rules, "read_file", input.workspace),
    shell: allows(rules, "command", input.workspace),
  });
}
