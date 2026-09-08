import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";

/**
 * Where the operator's decision to run an unscoped provider is written down (ADR 0008).
 *
 * It is a record of something BrainGate cannot prove and the operator can: that they accept a
 * provider reaching outside the project on this machine. It is never inferred from the provider
 * being installed, authenticated, or previously used, because none of those is a decision. It
 * carries a timestamp so it can go stale, and it can be revoked.
 *
 * No credential, token or provider secret is stored here — only a provider id, a moment, and
 * the sentence the operator was shown when they agreed.
 */

const SCHEMA_VERSION = 1;
// Matched to the subscription attestation window, because one `providers accept` produces both
// records and two expiries the operator has to track separately is a worse deal than one.
const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 30;

export interface ProviderAcceptanceRecord {
  readonly providerId: string;
  readonly source: "operator-accepted-unscoped-provider";
  readonly acceptedAt: string;
  readonly expiresAt: string;
  /** The risk the operator was shown, stored so a later reader sees what was agreed to. */
  readonly acknowledged: string;
}

interface AcceptanceDocument {
  readonly schemaVersion: 1;
  readonly records: readonly ProviderAcceptanceRecord[];
}

export const UNSCOPED_PROVIDER_RISK =
  "This provider's permissions cannot be scoped per invocation, so while BrainGate still verifies everything it does to the project, what it may read or write elsewhere on this machine is unchecked.";

/**
 * The second thing an acceptance asserts, said out loud rather than folded in silently.
 *
 * A provider BrainGate cannot scope is generally also one whose CLI does not report how it is
 * billed, and BrainGate refuses direct-billing authentication outright. Accepting the provider
 * is therefore also the operator stating which it is — a claim, recorded as a claim, that goes
 * stale on the same day the acceptance does.
 */
export const SUBSCRIPTION_SELF_ATTESTATION =
  "It also records that you are signed in to this provider with a subscription rather than direct API billing, because its CLI does not report which.";

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrainGateInvariantError("PROVIDER_ACCEPTANCE_INVALID", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseRecord(value: unknown): ProviderAcceptanceRecord {
  const row = asRecord(value, "Provider acceptance record");
  if (typeof row.providerId !== "string" || row.providerId.trim().length === 0) {
    throw new BrainGateInvariantError("PROVIDER_ACCEPTANCE_INVALID", "Provider acceptance record needs a provider id.");
  }
  if (row.source !== "operator-accepted-unscoped-provider") {
    throw new BrainGateInvariantError("PROVIDER_ACCEPTANCE_INVALID", "Provider acceptance record has an unrecognised source.");
  }
  for (const field of ["acceptedAt", "expiresAt"] as const) {
    if (typeof row[field] !== "string" || Number.isNaN(new Date(row[field] as string).getTime())) {
      throw new BrainGateInvariantError("PROVIDER_ACCEPTANCE_INVALID", `Provider acceptance ${field} must be an ISO timestamp.`);
    }
  }
  return Object.freeze({
    providerId: row.providerId,
    source: "operator-accepted-unscoped-provider",
    acceptedAt: row.acceptedAt as string,
    expiresAt: row.expiresAt as string,
    acknowledged: typeof row.acknowledged === "string" ? row.acknowledged : UNSCOPED_PROVIDER_RISK,
  });
}

function parseDocument(value: unknown): AcceptanceDocument {
  const document = asRecord(value, "Provider acceptance store");
  if (document.schemaVersion !== SCHEMA_VERSION || !Array.isArray(document.records)) {
    throw new BrainGateInvariantError("PROVIDER_ACCEPTANCE_VERSION", `Provider acceptance schemaVersion must be ${SCHEMA_VERSION}.`);
  }
  const seen = new Set<string>();
  const records = document.records.map((entry) => {
    const parsed = parseRecord(entry);
    if (seen.has(parsed.providerId)) throw new BrainGateInvariantError("PROVIDER_ACCEPTANCE_DUPLICATE", `Duplicate acceptance for ${parsed.providerId}.`);
    seen.add(parsed.providerId);
    return parsed;
  });
  records.sort((a, b) => a.providerId.localeCompare(b.providerId));
  return Object.freeze({ schemaVersion: 1, records: Object.freeze(records) });
}

export class ProviderAcceptanceStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  load(): readonly ProviderAcceptanceRecord[] {
    if (!existsSync(this.path)) return Object.freeze([]);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown; }
    catch (error) {
      throw new BrainGateInvariantError("PROVIDER_ACCEPTANCE_PARSE", `Could not parse the provider acceptance store: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseDocument(parsed).records;
  }

  /** The record for one provider, whether or not it is still current. */
  find(providerId: string): ProviderAcceptanceRecord | null {
    return this.load().find((record) => record.providerId === providerId) ?? null;
  }

  accept(providerId: string, options: { readonly now?: Date; readonly ttlDays?: number } = {}): ProviderAcceptanceRecord {
    const id = providerId.trim();
    if (id.length === 0) throw new BrainGateInvariantError("PROVIDER_ACCEPTANCE_INVALID", "A provider id is required.");
    const now = options.now ?? new Date();
    const ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
    if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_TTL_DAYS) {
      throw new BrainGateInvariantError("PROVIDER_ACCEPTANCE_INVALID", `Acceptance lasts between 1 and ${MAX_TTL_DAYS} days.`);
    }
    const record: ProviderAcceptanceRecord = Object.freeze({
      providerId: id,
      source: "operator-accepted-unscoped-provider",
      acceptedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString(),
      acknowledged: `${UNSCOPED_PROVIDER_RISK} ${SUBSCRIPTION_SELF_ATTESTATION}`,
    });
    this.#save([...this.load().filter((entry) => entry.providerId !== id), record]);
    return record;
  }

  revoke(providerId: string): boolean {
    const before = this.load();
    const after = before.filter((record) => record.providerId !== providerId);
    if (after.length === before.length) return false;
    this.#save(after);
    return true;
  }

  #save(records: readonly ProviderAcceptanceRecord[]): void {
    const document = parseDocument({ schemaVersion: 1, records });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }
}
