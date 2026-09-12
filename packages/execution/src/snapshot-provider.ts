/**
 * The snapshot provider the shadow invoker is handed.
 *
 * Keeps one snapshot per task in memory for the life of a run, which is what makes "one snapshot per
 * task, reused across failover attempts" true rather than a hope: the second provider asked to read
 * the project is given the same copy the first one read, provided by the same call.
 *
 * The evidence it returns carries a host path (`root`) because the invocation needs one. That value
 * lives in the process only — the ledger records the manifest hash, the counts, the policy version
 * and the source fingerprint, never the path.
 */
import { BrainGateInvariantError, type RegisteredProject } from "@braingate/core";
import { ProjectSnapshotter, sweepSnapshots, type ProjectSnapshot } from "./project-snapshot.js";

/**
 * The snapshot evidence a caller is given, shaped exactly as the shadow package's
 * `TaskSnapshotEvidence`.
 *
 * Declared here rather than imported so this package keeps its position under the provider layer: a
 * process/worktree package that imported the provider package would invert the layering for the sake
 * of two type names. The shapes are held together where they meet — the CLI assigns this provider to
 * the invoker's `TaskSnapshotProvider` parameter — so a drift between them is a compile error at the
 * boundary rather than a runtime surprise.
 */
export interface SnapshotEvidence {
  readonly snapshotId: string;
  readonly root: string;
  readonly manifestHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly policyVersion: string;
  readonly sourceFingerprint: string;
}

export interface SnapshotSweepSummary {
  readonly removed: number;
  readonly kept: number;
  readonly unrecognised: number;
}

export class ProjectSnapshotProvider {
  readonly #project: RegisteredProject;
  readonly #snapshotter: ProjectSnapshotter;
  readonly #byTask = new Map<string, ProjectSnapshot>();
  readonly #taskStart = new Map<string, string>();

  constructor(project: RegisteredProject) {
    this.#project = project;
    this.#snapshotter = new ProjectSnapshotter({ project });
  }

  beginTask(input: { readonly taskId: string; readonly source: string }): string {
    if (input.source.length === 0) throw new BrainGateInvariantError("SNAPSHOT_SOURCE_INVALID", "A project snapshot needs the source it is taken from.");
    const existing = this.#taskStart.get(input.taskId);
    if (existing !== undefined) return existing;
    const fingerprint = this.#snapshotter.fingerprint();
    this.#taskStart.set(input.taskId, fingerprint);
    return fingerprint;
  }

  ensure(input: { readonly taskId: string; readonly source: string }): SnapshotEvidence {
    const existing = this.#byTask.get(input.taskId);
    if (existing !== undefined) return evidenceOf(existing);
    if (input.source.length === 0) throw new BrainGateInvariantError("SNAPSHOT_SOURCE_INVALID", "A project snapshot needs the source it is taken from.");
    // If the task never recorded its starting state, the state at this moment is the closest thing to
    // it that exists — the copy is then coherent with itself, and the manifest says which fingerprint
    // it was taken of.
    const taskStart = this.#taskStart.get(input.taskId) ?? this.#snapshotter.fingerprint();
    const snapshot = this.#snapshotter.create({ taskId: input.taskId, expectedSourceFingerprint: taskStart });
    this.#byTask.set(input.taskId, snapshot);
    return evidenceOf(snapshot);
  }

  sweep(input: { readonly isTaskFinished?: (taskId: string) => boolean | undefined } = {}): SnapshotSweepSummary {
    const result = sweepSnapshots({
      project: this.#project,
      ...(input.isTaskFinished === undefined ? {} : { isTaskFinished: input.isTaskFinished }),
    });
    // A snapshot this process still holds is never swept (its pid is alive), so the in-memory map
    // stays consistent with what is on disk.
    return Object.freeze({ removed: result.removed.length, kept: result.kept.length, unrecognised: result.unrecognised.length });
  }

  verify(taskId: string): boolean {
    const snapshot = this.#byTask.get(taskId);
    // No snapshot for this task means nothing was given to a provider, so there is nothing to be
    // wrong about: reporting `true` here would be a claim about a copy that does not exist.
    if (snapshot === undefined) return true;
    return this.#snapshotter.verify(snapshot);
  }

  discard(taskId: string): void {
    this.#taskStart.delete(taskId);
    const snapshot = this.#byTask.get(taskId);
    if (snapshot === undefined) return;
    this.#byTask.delete(taskId);
    this.#snapshotter.discard(snapshot);
  }

  /** Snapshot directories left on disk by an earlier process, oldest first. */
  leftovers(): readonly string[] {
    return this.#snapshotter.list();
  }
}

function evidenceOf(snapshot: ProjectSnapshot): SnapshotEvidence {
  return Object.freeze({
    snapshotId: snapshot.id,
    root: snapshot.root,
    manifestHash: snapshot.manifestHash,
    fileCount: snapshot.manifest.fileCount,
    totalBytes: snapshot.manifest.totalBytes,
    policyVersion: snapshot.manifest.policyVersion,
    sourceFingerprint: snapshot.manifest.sourceFingerprint,
  });
}
