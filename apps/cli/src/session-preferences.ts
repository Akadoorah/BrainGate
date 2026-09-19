import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXECUTION_POLICY_IDS, isExecutionPolicyId, type ExecutionPolicyId } from "@braingate/core";

/**
 * The choices a session should not have to be told twice.
 *
 * `/policy worktree` and `/review on` are decisions about how work runs here, and re-making them
 * at the start of every session is the friction that makes a default the only setting anyone ever
 * uses. So they outlive the process — beside the thread, under the *workspace's* own storage,
 * because they are execution state and execution state is workspace-scoped (ADR 0016). Two
 * checkouts of one project can be run differently, and neither inherits the other's habits.
 *
 * Deliberately not `.brain/project.json`: that file is identity (ADR 0015), it is shared with
 * everyone who clones the repository, and it is refused on rewrite. A preference is neither
 * identity nor something to commit.
 *
 * Every field is optional and every read is tolerant. A preferences file that is missing, corrupt,
 * truncated or written by a later version means "no preferences", never a session that will not
 * start: a remembered convenience must not be able to take the terminal down with it.
 */

export interface SessionPreferences {
  /** The execution policy the next run uses, when the operator has chosen one. */
  readonly policy?: ExecutionPolicyId;
  /** Whether every write in this workspace asks for a reviewer, not only the ones that must. */
  readonly reviewAlways?: boolean;
  /** When the first-run wizard last finished here. Recorded so a rerun can say so. */
  readonly setupCompletedAt?: string;
}

interface StoredPreferences extends SessionPreferences {
  readonly schemaVersion: 1;
}

/** Where a workspace's preferences live: beside its thread, never in a shared place. */
export function sessionPreferencesPath(storageDir: string): string {
  return join(storageDir, "session", "preferences.json");
}

/** The preferences on record, or none. Never throws. */
export function readSessionPreferences(path: string): SessionPreferences {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { return Object.freeze({}); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { return Object.freeze({}); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return Object.freeze({});
  const row = parsed as Record<string, unknown>;
  if (row.schemaVersion !== 1) return Object.freeze({});
  // A policy this build does not know is dropped rather than carried: the session must never be
  // able to run under a boundary whose meaning it cannot state.
  const policy = typeof row.policy === "string" && isExecutionPolicyId(row.policy) ? row.policy : undefined;
  const reviewAlways = typeof row.reviewAlways === "boolean" ? row.reviewAlways : undefined;
  const setupCompletedAt = typeof row.setupCompletedAt === "string" && Number.isFinite(Date.parse(row.setupCompletedAt)) ? row.setupCompletedAt : undefined;
  return Object.freeze({
    ...(policy === undefined ? {} : { policy }),
    ...(reviewAlways === undefined ? {} : { reviewAlways }),
    ...(setupCompletedAt === undefined ? {} : { setupCompletedAt }),
  });
}

/**
 * Merges changes into what is on record and writes the result.
 *
 * A merge rather than a replace, because the callers each own one field: the wizard writes
 * `setupCompletedAt`, `/policy` writes `policy`, `/review` writes `reviewAlways`, and none of them
 * should be able to erase the others by not mentioning them.
 *
 * Failure is silent by design. A preference that could not be kept is still a working session, and
 * an unwritable state directory must not turn `/review on` into an error the operator has to solve
 * before they can work.
 */
export function updateSessionPreferences(path: string, changes: SessionPreferences): SessionPreferences {
  const merged: StoredPreferences = { schemaVersion: 1, ...readSessionPreferences(path), ...changes };
  if (merged.policy !== undefined && !EXECUTION_POLICY_IDS.includes(merged.policy)) {
    // Unreachable through the type, reachable through a stale file. Dropped, not written back.
    return readSessionPreferences(path);
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch { /* a preference that cannot be kept is still a working session */ }
  return readSessionPreferences(path);
}
