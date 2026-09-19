import type { ProviderSnapshot } from "@braingate/providers";
import type { ModelDefinition, ModelRole, SpeedClass } from "@braingate/router";
import { ModelCatalog, type ModelCatalogEntry } from "./model-catalog.js";

/**
 * Starting scores for the model families the installed CLIs actually expose.
 *
 * BrainGate has always refused to invent capability scores, and that refusal is what made the
 * first ten minutes a research task: nothing routes until a catalogue exists, and a catalogue is
 * a JSON file per model that nobody can write before they have used the thing. The refusal was
 * right about one half — a score BrainGate invents must never be presented as a measurement — and
 * wrong about the other: an operator with an empty catalogue is not protected by it, they are
 * stopped by it.
 *
 * So the defaults exist, and every one of them is labelled. An entry adopted from this table
 * carries `source: "braingate-default"` (or `"braingate-assumed"` where even the id is an
 * assumption), the wizard says so as it adopts, `models profile` says so afterwards, and an entry
 * the operator has scored themselves is *never* overwritten by any of it. Defaults are a starting
 * point the operator owns from the first run (ADR 0021).
 *
 * Where the numbers come from: the operator's own catalogue, which is the only scored catalogue
 * this project has ever had, read on 2026-09-19. Each row's roles are the roles the family is
 * chosen for by default; a family the operator wants in another role gets a score from them, which
 * is the point of the labelling.
 *
 * Where the *ids* come from: the installed CLIs, measured 2026-09-19 on this machine.
 *
 *   grok 1.0.30 — `grok models` prints "Available models:" and then `grok-4.6 (default)`,
 *     `grok-4.5`. Zero-prompt, and it names the signed-in account on the first line.
 *   agy 1.2.7 — `agy models` lists `gemini-3.8-flash-high|medium|low`, `gemini-3.7-flash-*`,
 *     `gemini-3.6-flash-*`, `gemini-3.1-pro-high`, `gemini-3.1-pro-low`, and — served through
 *     Antigravity rather than by Google — `claude-sonnet-4-6`, `claude-opus-4-6-thinking`,
 *     `gpt-oss-120b-medium`. The last three match no row here on purpose: a Claude model reached
 *     through Antigravity is not the Claude subscription, and guessing its pool would put two
 *     different bills in one bucket. They are imported unscored and named.
 *   claude 2.1.278 — has no `models` subcommand: `claude models` is read as a *prompt* and
 *     answers with prose, which is the opposite of a zero-prompt listing. Its ids are assumed.
 *   codex-cli 0.153.4 — `codex models` exits with "Error: stdin is not a terminal". Also assumed.
 */

/** The scored half of a model definition: everything that is a judgement rather than an identity. */
export interface DefaultModelProfile {
  readonly quotaPool: string;
  readonly capabilities: Readonly<Partial<Record<ModelRole, number>>>;
  readonly speed: SpeedClass;
  readonly contextCapacity: number;
  readonly writeCapable: boolean;
  readonly reasoning: number;
}

export interface DefaultModelProfileRow {
  readonly providerId: string;
  /** The family, as the installed CLI spells its ids. */
  readonly match: RegExp;
  /** What to call the family in a sentence. */
  readonly family: string;
  readonly profile: DefaultModelProfile;
}

/**
 * One row per family BrainGate is willing to start an operator on.
 *
 * Matched against the *provider's own* model id, per provider: `claude-sonnet-4-6` under `google`
 * is an Antigravity-served model and matches nothing here, which is the intended answer.
 */
export const DEFAULT_MODEL_PROFILES: readonly DefaultModelProfileRow[] = Object.freeze([
  {
    providerId: "anthropic",
    match: /(^|[-_])(opus|fable)([-_]|$)/i,
    family: "Claude Opus/Fable",
    profile: {
      quotaPool: "claude-subscription",
      capabilities: Object.freeze({ planner: 94, reviewer: 88, judge: 90 }),
      speed: "deep",
      contextCapacity: 1_000_000,
      writeCapable: true,
      reasoning: 95,
    },
  },
  {
    providerId: "anthropic",
    match: /(^|[-_])sonnet([-_]|$)/i,
    family: "Claude Sonnet",
    profile: {
      quotaPool: "claude-subscription",
      capabilities: Object.freeze({ coder: 90, reviewer: 84 }),
      speed: "balanced",
      contextCapacity: 1_000_000,
      writeCapable: true,
      reasoning: 85,
    },
  },
  {
    providerId: "anthropic",
    match: /(^|[-_])haiku([-_]|$)/i,
    family: "Claude Haiku",
    profile: {
      quotaPool: "claude-subscription",
      capabilities: Object.freeze({ coder: 70 }),
      speed: "fast",
      contextCapacity: 200_000,
      writeCapable: true,
      reasoning: 78,
    },
  },
  {
    providerId: "openai",
    match: /^(gpt-|codex)/i,
    family: "OpenAI GPT/Codex",
    profile: {
      quotaPool: "chatgpt-subscription",
      capabilities: Object.freeze({ coder: 72, reviewer: 93 }),
      speed: "balanced",
      contextCapacity: 400_000,
      writeCapable: true,
      reasoning: 92,
    },
  },
  {
    providerId: "google",
    match: /^gemini-.*pro/i,
    family: "Gemini Pro",
    // `writeCapable: false` matches the operator's own scoring of the Pro tiers, and costs
    // nothing a DIRECT write would otherwise have: whether `agy` may write headlessly at all is
    // read per run from the operator's Antigravity settings (ADR 0020), never from this table.
    profile: {
      quotaPool: "antigravity-subscription",
      capabilities: Object.freeze({ planner: 88, reviewer: 82 }),
      speed: "deep",
      contextCapacity: 1_000_000,
      writeCapable: false,
      reasoning: 90,
    },
  },
  {
    providerId: "google",
    match: /^gemini-.*flash/i,
    family: "Gemini Flash",
    profile: {
      quotaPool: "antigravity-subscription",
      capabilities: Object.freeze({ coder: 64 }),
      speed: "fast",
      contextCapacity: 1_000_000,
      writeCapable: true,
      reasoning: 70,
    },
  },
  {
    providerId: "xai",
    match: /^grok-4/i,
    family: "Grok 4",
    profile: {
      quotaPool: "grok-subscription",
      capabilities: Object.freeze({ coder: 70, reviewer: 80 }),
      speed: "balanced",
      contextCapacity: 256_000,
      writeCapable: true,
      reasoning: 80,
    },
  },
]);

/**
 * The ids BrainGate offers for the CLIs that publish no list.
 *
 * Two of the four runtimes have no zero-prompt `models` command (measured above), so discovery
 * reports `models: null` for them and adoption would otherwise skip the two subscriptions most
 * operators actually have. These are offered as *assumed* — labelled in the catalogue, labelled in
 * the wizard, and no more authoritative than that. An id that has gone stale simply fails at the
 * provider with its own error, and `braingate models remove` is one command.
 */
export const KNOWN_MODELS_WITHOUT_LISTING: readonly { readonly providerId: string; readonly modelId: string }[] = Object.freeze([
  { providerId: "anthropic", modelId: "claude-fable-5-1" },
  { providerId: "anthropic", modelId: "claude-opus-5" },
  { providerId: "anthropic", modelId: "claude-sonnet-5" },
  { providerId: "anthropic", modelId: "claude-haiku-4-5" },
  { providerId: "openai", modelId: "gpt-6-astra" },
]);

/** The starting scores for one model, or `null` when BrainGate has no opinion about it. */
export function defaultProfileFor(providerId: string, modelId: string): DefaultModelProfile | null {
  const row = DEFAULT_MODEL_PROFILES.find((candidate) => candidate.providerId === providerId && candidate.match.test(modelId));
  return row?.profile ?? null;
}

/** The family name, for a sentence that has to say which row matched. */
export function defaultFamilyFor(providerId: string, modelId: string): string | null {
  const row = DEFAULT_MODEL_PROFILES.find((candidate) => candidate.providerId === providerId && candidate.match.test(modelId));
  return row?.family ?? null;
}

/** The roles a profile gives a model, in a stable order, for printing. */
export function profileRoles(profile: DefaultModelProfile): readonly ModelRole[] {
  const order: readonly ModelRole[] = ["scout", "planner", "coder", "reviewer", "judge", "visual"];
  return Object.freeze(order.filter((role) => (profile.capabilities[role] ?? 0) > 0));
}

/** What adoption would do with one model id. */
export type AdoptionDisposition =
  /** Listed by the CLI and matched by a row: adopted with BrainGate's starting scores. */
  | "adopt"
  /** Not listed by any CLI, but a known id for it: adopted, and labelled an assumption. */
  | "assume"
  /** Already configured by the operator. Their scores stand; nothing is written. */
  | "keep"
  /** Listed and matched by nothing: imported so it is visible, with no scores at all. */
  | "unscored";

export interface AdoptionRow {
  readonly providerId: string;
  readonly modelId: string;
  readonly disposition: AdoptionDisposition;
  readonly profile: DefaultModelProfile | null;
  readonly roles: readonly ModelRole[];
  /** Where the id came from, in the operator's terms — `from agy models`, `assumed: …`. */
  readonly origin: string;
}

/**
 * What adoption *would* do, without doing any of it.
 *
 * The wizard prints this and then asks; `adoptDiscoveredModels` applies exactly the same rows. One
 * function rather than two, so the list the operator agreed to and the list that was written
 * cannot describe different catalogues.
 */
export function planModelAdoption(entries: readonly ModelCatalogEntry[], snapshots: readonly ProviderSnapshot[]): readonly AdoptionRow[] {
  const configured = new Set(entries.filter((entry) => entry.configured).map((entry) => `${entry.providerId}\u0000${entry.modelId}`));
  const rows: AdoptionRow[] = [];
  const seen = new Set<string>();
  const push = (row: AdoptionRow): void => {
    const key = `${row.providerId}\u0000${row.modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(Object.freeze(row));
  };

  for (const snapshot of snapshots) {
    // An installed CLI, and only that. A provider whose binary is missing has no models to adopt
    // and no login to offer; the wizard reports it separately.
    if (snapshot.available.value !== true) continue;
    const listed = snapshot.models.value ?? [];
    for (const modelId of listed) {
      const key = `${snapshot.providerId}\u0000${modelId}`;
      const profile = defaultProfileFor(snapshot.providerId, modelId);
      if (configured.has(key)) {
        push({ providerId: snapshot.providerId, modelId, disposition: "keep", profile, roles: profile === null ? Object.freeze([]) : profileRoles(profile), origin: "your scores" });
        continue;
      }
      if (profile === null) {
        push({ providerId: snapshot.providerId, modelId, disposition: "unscored", profile: null, roles: Object.freeze([]), origin: `from ${snapshot.binary} models, matched by no default` });
        continue;
      }
      push({ providerId: snapshot.providerId, modelId, disposition: "adopt", profile, roles: profileRoles(profile), origin: `from ${snapshot.binary} models` });
    }
    if (listed.length > 0) continue;
    // Nothing listed: the known ids for this runtime, if there are any, as assumptions.
    for (const known of KNOWN_MODELS_WITHOUT_LISTING) {
      if (known.providerId !== snapshot.providerId) continue;
      const profile = defaultProfileFor(known.providerId, known.modelId);
      if (profile === null) continue;
      const key = `${known.providerId}\u0000${known.modelId}`;
      if (configured.has(key)) {
        push({ ...known, disposition: "keep", profile, roles: profileRoles(profile), origin: "your scores" });
        continue;
      }
      push({ ...known, disposition: "assume", profile, roles: profileRoles(profile), origin: `assumed: ${snapshot.binary} lists no models` });
    }
  }
  return Object.freeze(rows);
}

export interface AdoptionResult {
  /** Adopted from a listed id with BrainGate's starting scores. */
  readonly adopted: readonly AdoptionRow[];
  /** Adopted from a known id for a CLI that lists none. */
  readonly assumed: readonly AdoptionRow[];
  /** Already the operator's. Untouched. */
  readonly kept: readonly AdoptionRow[];
  /** Listed, matched by nothing, imported with no scores. */
  readonly unscored: readonly AdoptionRow[];
  /** The catalogue as it stands afterwards. */
  readonly entries: readonly ModelCatalogEntry[];
}

/**
 * Writes the starting scores into the catalogue, and nothing else.
 *
 * The one invariant worth stating twice: a `configured: true` entry is never overwritten. The
 * operator's scores are their data (`memory/operator-owns-provider-decisions`), and a wizard that
 * re-applied defaults over them on every rerun would quietly undo their tuning — which is exactly
 * what makes `/setup` safe to run again.
 */
export function adoptDiscoveredModels(catalog: ModelCatalog, snapshots: readonly ProviderSnapshot[]): AdoptionResult {
  const rows = planModelAdoption(catalog.load(), snapshots);
  for (const row of rows) {
    if (row.profile === null) continue;
    if (row.disposition !== "adopt" && row.disposition !== "assume") continue;
    const definition: ModelDefinition = {
      providerId: row.providerId,
      modelId: row.modelId,
      quotaPool: row.profile.quotaPool,
      capabilities: row.profile.capabilities,
      speed: row.profile.speed,
      contextCapacity: row.profile.contextCapacity,
      writeCapable: row.profile.writeCapable,
      reasoning: row.profile.reasoning,
      underlyingFamily: null,
    };
    catalog.upsert(definition, { source: row.disposition === "assume" ? "braingate-assumed" : "braingate-default" });
  }
  // Everything the CLIs listed and no row matched, so it is at least visible and nameable. This
  // adds identities only — `configured: false`, no scores, no routing.
  const entries = rows.some((row) => row.disposition === "unscored") ? catalog.importDiscovered(snapshots) : catalog.load();
  const of = (disposition: AdoptionDisposition) => Object.freeze(rows.filter((row) => row.disposition === disposition));
  return Object.freeze({
    adopted: of("adopt"),
    assumed: of("assume"),
    kept: of("keep"),
    unscored: of("unscored"),
    entries,
  });
}
