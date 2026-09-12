/**
 * The seam between a provider invocation and the project snapshot it reads.
 *
 * Declared here, implemented in `@braingate/execution` and injected at the CLI edge, for the reason
 * the finalization seam is declared in core: the package that talks to providers must not acquire a
 * dependency on the package that copies projects, and the object that does the copying must not know
 * anything about providers. The interface is the whole contract between them.
 *
 * Nothing here is provider-specific, and nothing here grants anything: a provider still has to be
 * snapshot-capable, still has to hold a current sandbox attestation, and still reads a directory
 * BrainGate created rather than the operator's checkout.
 */
export interface TaskSnapshotEvidence {
  readonly snapshotId: string;
  /** The workspace the provider is pointed at. BrainGate-owned, never the source checkout. */
  readonly root: string;
  readonly manifestHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly policyVersion: string;
  /** Content fingerprint of the source the snapshot was taken from. */
  readonly sourceFingerprint: string;
}

export interface TaskSnapshotProvider {
  /**
   * Records the project state this task started from, before any provider is called.
   *
   * Every later copy is checked against it: a snapshot is only ever taken of the state the task
   * found, so a planner and the provider that answers cannot have read different projects.
   */
  beginTask(input: { readonly taskId: string; readonly source: string }): string;
  /**
   * The snapshot for this task, creating it on first use.
   *
   * One per task by construction: a failover that retried the primary on another provider must not
   * hand the second attempt a different copy of the project than the first attempt saw. Refuses
   * (`SNAPSHOT_SOURCE_CHANGED_SINCE_TASK_START`) if the project moved since `beginTask`.
   */
  ensure(input: { readonly taskId: string; readonly source: string }): TaskSnapshotEvidence;
  /** Re-reads the snapshot and reports whether it still matches its manifest, byte for byte. */
  verify(taskId: string): boolean;
  /** Removes the snapshot. Safe to call twice, and safe for a task that never made one. */
  discard(taskId: string): void;
  /** Removes copies whose owning process is gone. See the implementation's guarantee. */
  sweep(input?: { readonly isTaskFinished?: (taskId: string) => boolean | undefined }): SnapshotSweepSummary;
}

export interface SnapshotSweepSummary {
  readonly removed: number;
  readonly kept: number;
  readonly unrecognised: number;
}

/** Why a provider may not take the read-primary snapshot path. */
export const SNAPSHOT_PRIMARY_INELIGIBLE_REASONS = Object.freeze([
  "provider-not-snapshot-capable",
  "sandbox-attestation-missing-or-expired",
  "provider-unavailable",
] as const);
export type SnapshotPrimaryIneligibleReason = (typeof SNAPSHOT_PRIMARY_INELIGIBLE_REASONS)[number];

export function isSnapshotPrimaryIneligibleReason(value: unknown): value is SnapshotPrimaryIneligibleReason {
  return typeof value === "string" && (SNAPSHOT_PRIMARY_INELIGIBLE_REASONS as readonly string[]).includes(value);
}
