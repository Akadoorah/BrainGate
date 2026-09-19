import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The models Codex knows about, read from the list it caches itself.
 *
 * Codex has no zero-prompt `models` command: `codex models` on codex-cli 0.153.4 exits "stdin is
 * not a terminal", and the interactive picker is the only listing it offers. So the operator's
 * catalogue held one assumed id and the wizard adopted one model, while the CLI could run seven.
 * What Codex does keep is `models_cache.json` under its home — the list it fetched for its own
 * picker, with a `slug` per model (measured 2026-09-20 on codex-cli 0.153.4). Reading it is the
 * same kind of zero-cost, native-evidence probe as `grok models`: the CLI's own answer, read back
 * rather than asked again. It is never written.
 */
export interface CodexModelCache {
  /** The file consulted, so the reading can be checked by hand. */
  readonly path: string;
  /** Whether the file existed and parsed. */
  readonly present: boolean;
  /** The model ids, in the CLI's own order. */
  readonly models: readonly string[];
}

/** Where Codex keeps its state: `CODEX_HOME`, else `~/.codex`, as the CLI itself resolves it. */
export function codexHomePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.CODEX_HOME?.trim();
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : null;
  // The environment the command was given, not the process's: a caller that names no home (every
  // hermetic test) gets nothing, not the operator's real list leaking in.
  return home === null ? null : join(home, ".codex");
}

export function readCodexModelCache(input: { readonly env?: NodeJS.ProcessEnv; readonly text?: string | null } = {}): CodexModelCache {
  const env = input.env ?? process.env;
  const home = codexHomePath(env);
  const path = home === null ? join(homedir(), ".codex", "models_cache.json") : join(home, "models_cache.json");
  const text = input.text !== undefined ? input.text : home !== null && existsSync(path) ? readFileSync(path, "utf8") : null;
  if (text === null) return Object.freeze({ path, present: false, models: Object.freeze([]) });
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).models : undefined;
    const models = Array.isArray(list)
      ? list.map((entry) => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).slug : undefined)).filter((slug): slug is string => typeof slug === "string" && slug.trim().length > 0)
      : [];
    return Object.freeze({ path, present: true, models: Object.freeze(models) });
  } catch {
    return Object.freeze({ path, present: false, models: Object.freeze([]) });
  }
}
