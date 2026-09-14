import type { Finding } from "./types.js";

/**
 * A finding flattened to its content, for comparing two readings of a goal.
 *
 * Findings are compared by what they say rather than by their recorded representation, because the
 * two readings are the *same* finding seen twice: an id is stable, but the claim can be re-recorded
 * with more evidence attached, and reporting that as "a new finding" would overstate what changed.
 * Nothing here reads `recordedAt`, for the same reason — a timestamp is not a change.
 */
function fingerprint(finding: Finding): string {
  return `${finding.status}\u0000${finding.claim}\u0000${[...finding.evidence].join("\u0001")}`;
}

/**
 * Findings present now that were not present in the previous reading.
 *
 * When there is no previous reading the answer is *nothing*, not everything. A caller with no
 * baseline cannot know what is new, and reporting the whole list as new would turn a returning
 * worker's delta into the full handoff it exists to avoid.
 */
export function compareFindings(current: readonly Finding[], previous: readonly Finding[] | null): readonly Finding[] {
  if (previous === null) return Object.freeze([]);
  const known = new Set(previous.map(fingerprint));
  return Object.freeze(current.filter((finding) => !known.has(fingerprint(finding))));
}
