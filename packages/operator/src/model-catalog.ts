import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import type { ProviderSnapshot } from "@braingate/providers";
import { ModelRegistry, type ModelDefinition } from "@braingate/router";

const SCHEMA_VERSION = 1;

/**
 * Who decided a configured entry's scores.
 *
 * Derived from a runtime list so the union and the check cannot drift. An entry with no `source`
 * is the operator's: that is what every catalogue written before M23 is, and reading it as
 * anything else would relabel their work as a guess. Only BrainGate's own starting scores are
 * marked, because only those need to be distinguishable from a measurement (ADR 0021).
 */
export const MODEL_SCORE_SOURCES = ["operator", "braingate-default", "braingate-assumed"] as const;
export type ModelScoreSource = (typeof MODEL_SCORE_SOURCES)[number];

export function isModelScoreSource(value: string): value is ModelScoreSource {
  return (MODEL_SCORE_SOURCES as readonly string[]).includes(value);
}

export type ModelCatalogEntry =
  | {
      readonly providerId: string;
      readonly modelId: string;
      readonly configured: false;
    }
  | {
      readonly providerId: string;
      readonly modelId: string;
      readonly configured: true;
      readonly definition: ModelDefinition;
      /** Absent means the operator's own. See `MODEL_SCORE_SOURCES`. */
      readonly source?: ModelScoreSource;
    };

interface CatalogDocument {
  readonly schemaVersion: 1;
  readonly entries: readonly ModelCatalogEntry[];
}

function key(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function validateOpaqueIdentity(providerId: string, modelId: string): void {
  const probe = new ModelRegistry();
  probe.register(
    {
      providerId,
      modelId,
      quotaPool: "unscored",
      capabilities: {},
      speed: "fast",
      contextCapacity: 1_000,
      writeCapable: false,
      reasoning: 0,
      underlyingFamily: null,
    },
    { available: false, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: new Date(0).toISOString() },
  );
}

function validateDefinition(definition: ModelDefinition): ModelDefinition {
  const registry = new ModelRegistry();
  const registered = registry.register(
    definition,
    { available: false, quotaState: "unknown", quotaHint: null, quotaObservedAt: null, refusalBackoffUntil: null, observedAt: new Date(0).toISOString() },
  );
  return registered.definition;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrainGateInvariantError("MODEL_CATALOG_INVALID", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseEntry(value: unknown): ModelCatalogEntry {
  const row = asRecord(value, "Model catalog entry");
  if (typeof row.providerId !== "string" || typeof row.modelId !== "string" || typeof row.configured !== "boolean") {
    throw new BrainGateInvariantError("MODEL_CATALOG_INVALID", "Model catalog entry identity/configured fields are invalid.");
  }
  validateOpaqueIdentity(row.providerId, row.modelId);
  if (!row.configured) return Object.freeze({ providerId: row.providerId, modelId: row.modelId, configured: false });
  const definitionRecord = asRecord(row.definition, "Configured model definition");
  const definition = validateDefinition(definitionRecord as unknown as ModelDefinition);
  if (definition.providerId !== row.providerId || definition.modelId !== row.modelId) {
    throw new BrainGateInvariantError("MODEL_CATALOG_IDENTITY_MISMATCH", "Catalog entry identity must match its configured definition.");
  }
  // Unrecognised is refused rather than dropped: a label that decides whether scores are presented
  // as the operator's must not be able to disappear because it was spelled differently.
  if (row.source !== undefined && (typeof row.source !== "string" || !isModelScoreSource(row.source))) {
    throw new BrainGateInvariantError("MODEL_CATALOG_INVALID", `Model catalog entry source must be one of: ${MODEL_SCORE_SOURCES.join(", ")}.`);
  }
  const source = row.source === undefined ? "operator" : (row.source as ModelScoreSource);
  // "operator" is the absence of a label, and it is written as an absence: a catalogue that has
  // never met the wizard stays byte-comparable to the one it had before.
  return Object.freeze({ providerId: row.providerId, modelId: row.modelId, configured: true, definition, ...(source === "operator" ? {} : { source }) });
}

function parseDocument(value: unknown): CatalogDocument {
  const document = asRecord(value, "Model catalog");
  if (document.schemaVersion !== SCHEMA_VERSION || !Array.isArray(document.entries)) {
    throw new BrainGateInvariantError("MODEL_CATALOG_VERSION", `Model catalog schemaVersion must be ${SCHEMA_VERSION}.`);
  }
  const seen = new Set<string>();
  const entries = document.entries.map((entry) => {
    const parsed = parseEntry(entry);
    const id = key(parsed.providerId, parsed.modelId);
    if (seen.has(id)) throw new BrainGateInvariantError("MODEL_CATALOG_DUPLICATE", `Duplicate catalog model ${parsed.providerId}/${parsed.modelId}.`);
    seen.add(id);
    return parsed;
  });
  entries.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze(entries) });
}

function emptyDocument(): CatalogDocument {
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze([]) });
}

export class ModelCatalog {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  load(): readonly ModelCatalogEntry[] {
    if (!existsSync(this.path)) return Object.freeze([]);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown; }
    catch (error) {
      throw new BrainGateInvariantError("MODEL_CATALOG_PARSE", `Could not parse model catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseDocument(parsed).entries;
  }

  validate(): readonly ModelCatalogEntry[] {
    return this.load();
  }

  configured(): readonly ModelDefinition[] {
    return Object.freeze(this.load().filter((entry): entry is Extract<ModelCatalogEntry, { configured: true }> => entry.configured).map((entry) => entry.definition));
  }

  /**
   * Writes one scored model.
   *
   * `source` says who decided the scores, and defaults to the operator: everything that reaches
   * this method from `models add` or from a hand-written definition is theirs. Only
   * `adoptDiscoveredModels` passes anything else.
   */
  upsert(definition: ModelDefinition, options: { readonly source?: ModelScoreSource } = {}): readonly ModelCatalogEntry[] {
    const safe = validateDefinition(definition);
    const source = options.source ?? "operator";
    const entries = this.load().filter((entry) => key(entry.providerId, entry.modelId) !== key(safe.providerId, safe.modelId));
    entries.push(Object.freeze({ providerId: safe.providerId, modelId: safe.modelId, configured: true as const, definition: safe, ...(source === "operator" ? {} : { source }) }));
    return this.#save(entries);
  }

  remove(providerId: string, modelId: string): readonly ModelCatalogEntry[] {
    validateOpaqueIdentity(providerId, modelId);
    const before = this.load();
    const after = before.filter((entry) => key(entry.providerId, entry.modelId) !== key(providerId, modelId));
    if (after.length === before.length) throw new BrainGateInvariantError("MODEL_CATALOG_NOT_FOUND", `Model ${providerId}/${modelId} is not in the catalog.`);
    return this.#save(after);
  }

  importDiscovered(snapshots: readonly ProviderSnapshot[]): readonly ModelCatalogEntry[] {
    const entries = [...this.load()];
    const existing = new Set(entries.map((entry) => key(entry.providerId, entry.modelId)));
    for (const snapshot of snapshots) {
      for (const modelId of snapshot.models.value ?? []) {
        const id = key(snapshot.providerId, modelId);
        if (existing.has(id)) continue;
        validateOpaqueIdentity(snapshot.providerId, modelId);
        entries.push(Object.freeze({ providerId: snapshot.providerId, modelId, configured: false as const }));
        existing.add(id);
      }
    }
    return this.#save(entries);
  }

  #save(entries: readonly ModelCatalogEntry[]): readonly ModelCatalogEntry[] {
    const document = parseDocument({ schemaVersion: 1, entries });
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
    return document.entries;
  }
}
