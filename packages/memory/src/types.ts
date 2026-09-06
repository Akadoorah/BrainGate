export type MemoryKind =
  | "architecture_decision"
  | "business_rule"
  | "verified_fact"
  | "task_summary"
  | "known_bug"
  | "incident"
  | "code_reference"
  | "temporary_observation";

export type MemoryReviewDecision = "approved" | "rejected";
export type MemoryEffectiveStatus = "active" | "superseded" | "expired";

export interface MemoryProposalInput {
  readonly kind: MemoryKind;
  readonly body: string;
  readonly reason: string;
  readonly sourceRefs: readonly string[];
  readonly proposedBy: string;
  readonly ttlDays?: number | null;
  readonly supersedesId?: string | null;
}

export interface MemoryProposal {
  readonly proposalId: string;
  readonly projectId: string;
  readonly kind: MemoryKind;
  readonly body: string;
  readonly reason: string;
  readonly sourceRefs: readonly string[];
  readonly proposedBy: string;
  readonly ttlDays: number | null;
  readonly supersedesId: string | null;
  readonly proposedAt: string;
}

export interface MemoryVerification {
  readonly verifier: string;
  readonly evidenceRefs: readonly string[];
  readonly confidence: number;
  readonly commitRef?: string | null;
  readonly notes?: string | null;
}

export interface MemoryReview {
  readonly sequence: number;
  readonly proposalId: string;
  readonly projectId: string;
  readonly decision: MemoryReviewDecision;
  readonly verifier: string;
  readonly evidenceRefs: readonly string[];
  readonly confidence: number | null;
  readonly commitRef: string | null;
  readonly notes: string | null;
  readonly reviewedAt: string;
}

export interface MemoryRecord {
  readonly recordId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly kind: MemoryKind;
  readonly body: string;
  readonly reason: string;
  readonly sourceRefs: readonly string[];
  readonly confidence: number;
  readonly commitRef: string | null;
  readonly supersedesId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly effectiveStatus: MemoryEffectiveStatus;
}

export interface MemorySearchHit {
  readonly record: MemoryRecord;
  readonly score: number;
}

export interface MemorySupervisor {
  approve(proposalId: string, verification: MemoryVerification): MemoryRecord;
  reject(proposalId: string, input: { verifier: string; evidenceRefs: readonly string[]; notes?: string | null }): MemoryReview;
}
