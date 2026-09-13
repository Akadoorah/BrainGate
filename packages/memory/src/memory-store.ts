import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  BrainGateInvariantError,
  assertRegisteredProject,
  isExecutionProject,
  type RegisteredProject,
} from "@braingate/core";
import { defaultMemoryTtlDays } from "./retention.js";
import type {
  MemoryEffectiveStatus,
  MemoryKind,
  MemoryProposal,
  MemoryProposalInput,
  MemoryRecord,
  MemoryReview,
  MemorySearchHit,
  MemorySupervisor,
  MemoryVerification,
} from "./types.js";

const MEMORY_KINDS = new Set<MemoryKind>([
  "architecture_decision",
  "business_rule",
  "verified_fact",
  "task_summary",
  "known_bug",
  "incident",
  "code_reference",
  "temporary_observation",
]);

const MAX_SEARCH_RESULTS = 20;
const MAX_BODY_CHARS = 50_000;
const MAX_REASON_CHARS = 4_000;
const MAX_SOURCE_REFS = 32;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk|xai)-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s]{8,}/i,
];

interface ProposalRow {
  proposal_id: string;
  project_id: string;
  kind: MemoryKind;
  body: string;
  reason: string;
  source_refs_json: string;
  proposed_by: string;
  ttl_days: number | null;
  supersedes_id: string | null;
  proposed_at: string;
}

interface ReviewRow {
  sequence: number;
  proposal_id: string;
  project_id: string;
  decision: "approved" | "rejected";
  verifier: string;
  evidence_refs_json: string;
  confidence: number | null;
  commit_ref: string | null;
  notes: string | null;
  reviewed_at: string;
}

interface RecordRow {
  record_id: string;
  project_id: string;
  proposal_id: string;
  kind: MemoryKind;
  body: string;
  reason: string;
  source_refs_json: string;
  confidence: number;
  commit_ref: string | null;
  supersedes_id: string | null;
  created_at: string;
  expires_at: string | null;
}

function nonEmpty(value: string, field: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxChars) {
    throw new BrainGateInvariantError("MEMORY_FIELD_INVALID", `${field} must be 1-${maxChars} characters.`);
  }
  return normalized;
}

function assertNoObviousSecret(value: string, field: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new BrainGateInvariantError("MEMORY_SECRET_REJECTED", `${field} appears to contain a secret and cannot be stored in memory.`);
  }
}

function validateRefs(values: readonly string[], field: string): readonly string[] {
  if (values.length === 0 || values.length > MAX_SOURCE_REFS) {
    throw new BrainGateInvariantError("MEMORY_REFS_INVALID", `${field} must contain 1-${MAX_SOURCE_REFS} references.`);
  }
  const normalized = values.map((value) => {
    const ref = nonEmpty(value, field, 512);
    assertNoObviousSecret(ref, field);
    return ref;
  });
  return Object.freeze([...new Set(normalized)]);
}

function validateTtl(kind: MemoryKind, value: number | null | undefined): number | null {
  const ttl = value === undefined ? defaultMemoryTtlDays(kind) : value;
  if (ttl === null) return null;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3650) {
    throw new BrainGateInvariantError("MEMORY_TTL_INVALID", "ttlDays must be null or an integer between 1 and 3650.");
  }
  return ttl;
}

function mapProposal(row: ProposalRow): MemoryProposal {
  return {
    proposalId: row.proposal_id,
    projectId: row.project_id,
    kind: row.kind,
    body: row.body,
    reason: row.reason,
    sourceRefs: JSON.parse(row.source_refs_json) as string[],
    proposedBy: row.proposed_by,
    ttlDays: row.ttl_days,
    supersedesId: row.supersedes_id,
    proposedAt: row.proposed_at,
  };
}

function mapReview(row: ReviewRow): MemoryReview {
  return {
    sequence: row.sequence,
    proposalId: row.proposal_id,
    projectId: row.project_id,
    decision: row.decision,
    verifier: row.verifier,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
    confidence: row.confidence,
    commitRef: row.commit_ref,
    notes: row.notes,
    reviewedAt: row.reviewed_at,
  };
}

function effectiveStatus(row: RecordRow, nowIso: string, superseded: boolean): MemoryEffectiveStatus {
  if (superseded) return "superseded";
  if (row.expires_at !== null && row.expires_at <= nowIso) return "expired";
  return "active";
}

function mapRecord(row: RecordRow, nowIso: string, superseded: boolean): MemoryRecord {
  return {
    recordId: row.record_id,
    projectId: row.project_id,
    proposalId: row.proposal_id,
    kind: row.kind,
    body: row.body,
    reason: row.reason,
    sourceRefs: JSON.parse(row.source_refs_json) as string[],
    confidence: row.confidence,
    commitRef: row.commit_ref,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    effectiveStatus: effectiveStatus(row, nowIso, superseded),
  };
}

function ftsQuery(value: string): string | null {
  const tokens = value.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const unique = [...new Set(tokens.map((token) => token.toLocaleLowerCase()).filter((token) => token.length > 0))];
  if (unique.length === 0) return null;
  return unique.slice(0, 12).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export class ProjectMemory {
  readonly #project: RegisteredProject;
  readonly #db: Database.Database;
  readonly #clock: () => Date;
  readonly databasePath: string;
  readonly projectId: string;

  constructor(project: RegisteredProject, options: { clock?: () => Date } = {}) {
    assertRegisteredProject(project);
    // Canonical memory is durable project knowledge: it outlives every workspace and is the one
    // thing an operator promotes *out of* local work. An execution handle carries a workspace's
    // storage, so accepting one would file project memory under whichever directory happened to be
    // current — which is how knowledge silently becomes local.
    if (isExecutionProject(project)) {
      throw new BrainGateInvariantError("MEMORY_SCOPE_INVALID", "Durable memory is project-scoped; a workspace execution handle cannot own it.");
    }
    this.#project = project;
    this.projectId = project.projectId;
    this.#clock = options.clock ?? (() => new Date());
    this.databasePath = join(project.storageDir, "memory.sqlite");
    this.#db = new Database(this.databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  propose(input: MemoryProposalInput): MemoryProposal {
    if (!MEMORY_KINDS.has(input.kind)) {
      throw new BrainGateInvariantError("MEMORY_KIND_INVALID", `Unsupported memory kind: ${String(input.kind)}`);
    }
    const body = nonEmpty(input.body, "body", MAX_BODY_CHARS);
    const reason = nonEmpty(input.reason, "reason", MAX_REASON_CHARS);
    const proposedBy = nonEmpty(input.proposedBy, "proposedBy", 128);
    assertNoObviousSecret(body, "body");
    assertNoObviousSecret(reason, "reason");
    assertNoObviousSecret(proposedBy, "proposedBy");
    const sourceRefs = validateRefs(input.sourceRefs, "sourceRefs");
    const ttlDays = validateTtl(input.kind, input.ttlDays);
    const supersedesId = input.supersedesId ?? null;
    if (supersedesId !== null) assertNoObviousSecret(supersedesId, "supersedesId");

    const proposalId = randomUUID();
    const proposedAt = this.#clock().toISOString();
    this.#db.prepare(`
      INSERT INTO memory_proposals (
        proposal_id, project_id, kind, body, reason, source_refs_json, proposed_by,
        ttl_days, supersedes_id, proposed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposalId,
      this.projectId,
      input.kind,
      body,
      reason,
      JSON.stringify(sourceRefs),
      proposedBy,
      ttlDays,
      supersedesId,
      proposedAt,
    );
    return this.requireProposal(proposalId);
  }

  getProposal(proposalId: string): MemoryProposal | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM memory_proposals WHERE proposal_id = ? AND project_id = ?",
    ).get(proposalId, this.projectId) as ProposalRow | undefined;
    return row === undefined ? undefined : mapProposal(row);
  }

  requireProposal(proposalId: string): MemoryProposal {
    const proposal = this.getProposal(proposalId);
    if (proposal === undefined) {
      throw new BrainGateInvariantError("MEMORY_PROPOSAL_NOT_FOUND", `Unknown proposal ${proposalId} in project ${this.projectId}.`);
    }
    return proposal;
  }

  /**
   * Proposals still waiting on a decision, newest first.
   *
   * A proposal nobody can see is a proposal nobody will promote, and the store had a way to
   * record one and no way to list them. Reviewed proposals are left out: this answers "what is
   * waiting on me", not "what has ever been said".
   */
  listProposals(limit = 20): readonly MemoryProposal[] {
    const bounded = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(limit)));
    const rows = this.#db.prepare(`
      SELECT p.* FROM memory_proposals p
      LEFT JOIN memory_reviews r ON r.proposal_id = p.proposal_id
      WHERE p.project_id = ? AND r.proposal_id IS NULL
      ORDER BY p.proposed_at DESC, p.proposal_id DESC
      LIMIT ?
    `).all(this.projectId, bounded) as ProposalRow[];
    return Object.freeze(rows.map(mapProposal));
  }

  getRecord(recordId: string): MemoryRecord | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM memory_records WHERE record_id = ? AND project_id = ?",
    ).get(recordId, this.projectId) as RecordRow | undefined;
    if (row === undefined) return undefined;
    const superseded = this.#isSuperseded(recordId);
    return mapRecord(row, this.#clock().toISOString(), superseded);
  }

  listEffective(limit = 10): readonly MemoryRecord[] {
    const bounded = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(limit)));
    const nowIso = this.#clock().toISOString();
    const rows = this.#db.prepare(`
      SELECT r.*
      FROM memory_records r
      WHERE r.project_id = ?
        AND (r.expires_at IS NULL OR r.expires_at > ?)
        AND NOT EXISTS (
          SELECT 1 FROM memory_records newer WHERE newer.supersedes_id = r.record_id
        )
      ORDER BY r.created_at DESC, r.record_id ASC
      LIMIT ?
    `).all(this.projectId, nowIso, bounded) as RecordRow[];
    return Object.freeze(rows.map((row) => mapRecord(row, nowIso, false)));
  }

  search(query: string, options: { limit?: number; kinds?: readonly MemoryKind[] } = {}): readonly MemorySearchHit[] {
    const bounded = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(options.limit ?? 8)));
    const parsed = ftsQuery(query);
    if (parsed === null) {
      return this.listEffective(bounded).map((record, index) => ({ record, score: index }));
    }
    const nowIso = this.#clock().toISOString();
    const kinds = options.kinds?.filter((kind) => MEMORY_KINDS.has(kind)) ?? [];
    const kindClause = kinds.length === 0 ? "" : ` AND r.kind IN (${kinds.map(() => "?").join(",")})`;
    const params: unknown[] = [parsed, this.projectId, nowIso, ...kinds, bounded];
    const rows = this.#db.prepare(`
      SELECT r.*, bm25(memory_fts) AS score
      FROM memory_fts
      JOIN memory_records r ON r.record_id = memory_fts.record_id
      WHERE memory_fts MATCH ?
        AND r.project_id = ?
        AND (r.expires_at IS NULL OR r.expires_at > ?)
        AND NOT EXISTS (
          SELECT 1 FROM memory_records newer WHERE newer.supersedes_id = r.record_id
        )
        ${kindClause}
      ORDER BY score ASC, r.created_at DESC
      LIMIT ?
    `).all(...params) as (RecordRow & { score: number })[];
    return Object.freeze(rows.map((row) => ({ record: mapRecord(row, nowIso, false), score: row.score })));
  }

  supervisor(): MemorySupervisor {
    return Object.freeze({
      approve: (proposalId: string, verification: MemoryVerification) => this.#approve(proposalId, verification),
      reject: (proposalId: string, input: { verifier: string; evidenceRefs: readonly string[]; notes?: string | null }) =>
        this.#reject(proposalId, input),
    });
  }

  #approve(proposalId: string, verification: MemoryVerification): MemoryRecord {
    const proposal = this.requireProposal(proposalId);
    this.#assertUnreviewed(proposalId);
    const verifier = nonEmpty(verification.verifier, "verifier", 128);
    const evidenceRefs = validateRefs(verification.evidenceRefs, "evidenceRefs");
    if (!Number.isFinite(verification.confidence) || verification.confidence < 0 || verification.confidence > 1) {
      throw new BrainGateInvariantError("MEMORY_CONFIDENCE_INVALID", "confidence must be between 0 and 1.");
    }
    const commitRef = verification.commitRef?.trim() || null;
    const notes = verification.notes?.trim() || null;
    for (const [field, value] of [["verifier", verifier], ["commitRef", commitRef], ["notes", notes]] as const) {
      if (value !== null) assertNoObviousSecret(value, field);
    }
    if (proposal.supersedesId !== null) {
      const target = this.getRecord(proposal.supersedesId);
      if (target === undefined) {
        throw new BrainGateInvariantError("MEMORY_SUPERSEDES_NOT_FOUND", `Cannot supersede unknown record ${proposal.supersedesId}.`);
      }
    }

    const reviewedAt = this.#clock().toISOString();
    const expiresAt = proposal.ttlDays === null
      ? null
      : new Date(new Date(reviewedAt).getTime() + proposal.ttlDays * 86_400_000).toISOString();
    const recordId = randomUUID();

    const transaction = this.#db.transaction(() => {
      const review = this.#db.prepare(`
        INSERT INTO memory_reviews (
          proposal_id, project_id, decision, verifier, evidence_refs_json,
          confidence, commit_ref, notes, reviewed_at
        ) VALUES (?, ?, 'approved', ?, ?, ?, ?, ?, ?)
      `).run(
        proposalId,
        this.projectId,
        verifier,
        JSON.stringify(evidenceRefs),
        verification.confidence,
        commitRef,
        notes,
        reviewedAt,
      );
      this.#db.prepare(`
        INSERT INTO memory_records (
          record_id, project_id, proposal_id, review_sequence, kind, body, reason,
          source_refs_json, confidence, commit_ref, supersedes_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        this.projectId,
        proposalId,
        Number(review.lastInsertRowid),
        proposal.kind,
        proposal.body,
        proposal.reason,
        JSON.stringify(proposal.sourceRefs),
        verification.confidence,
        commitRef,
        proposal.supersedesId,
        reviewedAt,
        expiresAt,
      );
      this.#db.prepare("INSERT INTO memory_fts (record_id, body) VALUES (?, ?)").run(recordId, proposal.body);
    });
    transaction();
    const record = this.getRecord(recordId);
    if (record === undefined) throw new BrainGateInvariantError("MEMORY_RECORD_MISSING", "Approved memory record was not persisted.");
    return record;
  }

  #reject(
    proposalId: string,
    input: { verifier: string; evidenceRefs: readonly string[]; notes?: string | null },
  ): MemoryReview {
    this.requireProposal(proposalId);
    this.#assertUnreviewed(proposalId);
    const verifier = nonEmpty(input.verifier, "verifier", 128);
    const evidenceRefs = validateRefs(input.evidenceRefs, "evidenceRefs");
    const notes = input.notes?.trim() || null;
    assertNoObviousSecret(verifier, "verifier");
    if (notes !== null) assertNoObviousSecret(notes, "notes");
    const reviewedAt = this.#clock().toISOString();
    const result = this.#db.prepare(`
      INSERT INTO memory_reviews (
        proposal_id, project_id, decision, verifier, evidence_refs_json,
        confidence, commit_ref, notes, reviewed_at
      ) VALUES (?, ?, 'rejected', ?, ?, NULL, NULL, ?, ?)
    `).run(proposalId, this.projectId, verifier, JSON.stringify(evidenceRefs), notes, reviewedAt);
    const row = this.#db.prepare("SELECT * FROM memory_reviews WHERE sequence = ?").get(Number(result.lastInsertRowid)) as ReviewRow;
    return mapReview(row);
  }

  #assertUnreviewed(proposalId: string): void {
    const exists = this.#db.prepare("SELECT 1 AS found FROM memory_reviews WHERE proposal_id = ?").get(proposalId) as { found: number } | undefined;
    if (exists !== undefined) {
      throw new BrainGateInvariantError("MEMORY_PROPOSAL_ALREADY_REVIEWED", `Proposal ${proposalId} was already reviewed.`);
    }
  }

  #isSuperseded(recordId: string): boolean {
    const row = this.#db.prepare("SELECT 1 AS found FROM memory_records WHERE supersedes_id = ? LIMIT 1").get(recordId) as { found: number } | undefined;
    return row !== undefined;
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memory_proposals (
        proposal_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'architecture_decision','business_rule','verified_fact','task_summary',
          'known_bug','incident','code_reference','temporary_observation'
        )),
        body TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        proposed_by TEXT NOT NULL,
        ttl_days INTEGER,
        supersedes_id TEXT,
        proposed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_reviews (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
        verifier TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        confidence REAL,
        commit_ref TEXT,
        notes TEXT,
        reviewed_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES memory_proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS memory_records (
        record_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL UNIQUE,
        review_sequence INTEGER NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        commit_ref TEXT,
        supersedes_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        FOREIGN KEY (proposal_id) REFERENCES memory_proposals(proposal_id),
        FOREIGN KEY (review_sequence) REFERENCES memory_reviews(sequence),
        FOREIGN KEY (supersedes_id) REFERENCES memory_records(record_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_one_superseder
        ON memory_records(supersedes_id) WHERE supersedes_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_memory_project_created ON memory_records(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_expiry ON memory_records(expires_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        record_id UNINDEXED,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS memory_proposals_no_update
      BEFORE UPDATE ON memory_proposals BEGIN
        SELECT RAISE(ABORT, 'memory_proposals are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS memory_proposals_no_delete
      BEFORE DELETE ON memory_proposals BEGIN
        SELECT RAISE(ABORT, 'memory_proposals are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS memory_reviews_no_update
      BEFORE UPDATE ON memory_reviews BEGIN
        SELECT RAISE(ABORT, 'memory_reviews are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS memory_reviews_no_delete
      BEFORE DELETE ON memory_reviews BEGIN
        SELECT RAISE(ABORT, 'memory_reviews are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS memory_records_no_update
      BEFORE UPDATE ON memory_records BEGIN
        SELECT RAISE(ABORT, 'memory_records are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS memory_records_no_delete
      BEFORE DELETE ON memory_records BEGIN
        SELECT RAISE(ABORT, 'memory_records are immutable');
      END;
    `);
  }
}
