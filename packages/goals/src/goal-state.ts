import type { Finding, FindingClaim, FindingStatus, GoalState } from "./types.js";
import { redactSecrets } from "@braingate/security";

/**
 * How much of a goal's state is carried.
 *
 * Bounds, and deliberate ones. The failure this milestone fixes is a handoff that lost state; a
 * handoff carrying two hundred findings fails the same way by a different route, because the
 * worker reads none of it. Full answers, diffs and test output stay in the result store — this is
 * the current picture, and the timeline holds the history that produced it.
 */
export const MAX_ACCEPTED_FINDINGS = 8;
export const MAX_SECONDARY_FINDINGS = 8;
export const MAX_DISPUTED_FINDINGS = 8;
export const MAX_OPEN_QUESTIONS = 8;
export const MAX_SCOPE_ENTRIES = 16;
export const MAX_FILES_CHANGED = 24;
export const MAX_TESTS_RUN = 12;
export const MAX_EVIDENCE_PER_FINDING = 6;

export const MAX_FINDING_CHARS = 600;
export const MAX_FIELD_CHARS = 400;
export const MAX_PATH_CHARS = 300;
export const MAX_NEXT_ACTION_CHARS = 600;
/** Aggregate ceiling, so twenty short fields cannot add up to a prompt nobody budgeted for. */
export const MAX_HANDOFF_CHARS = 8_000;

/**
 * Words that carry no subject.
 *
 * The conflict check is an overlap heuristic, so its failure mode is a *false* conflict — usually
 * because two findings share nothing but "the" and "is". Dropping the scaffolding is what makes an
 * overlap mean the two are talking about the same thing.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those", "there",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "doing", "done",
  "has", "have", "had", "having", "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "not", "no", "nor", "so", "as", "at", "by", "for", "from", "in", "into", "of", "on", "onto", "to", "with",
  "it", "its", "it's", "we", "our", "you", "your", "they", "their", "he", "she", "his", "her", "them",
  "because", "when", "while", "where", "which", "who", "whom", "what", "why", "how", "all", "any", "both",
  "each", "few", "more", "most", "other", "some", "such", "only", "own", "same", "too", "very", "just",
  "also", "about", "after", "before", "during", "over", "under", "again", "further", "once", "here",
  "cause", "causes", "caused", "causing", "root", "issue", "problem", "bug", "actual", "actually",
  "real", "really", "likely", "probably", "possible", "currently", "still", "even", "however", "therefore",
  "instead", "rather", "based", "given", "found", "seems", "appears", "rather", "true", "false",
]);

/**
 * Whether two claims are about the same subject, cheaply.
 *
 * Two content words in common, at least one of them long enough to be a real subject word rather
 * than an abbreviation. Deliberately shallow: this decides whether to *flag* a contradiction, not
 * whether to believe one, and the cost of a false positive here is a disagreement recorded that a
 * human reads and dismisses — which is far cheaper than the cost of a false negative, where a
 * worker quietly replaces an established diagnosis.
 *
 * Not a model call. A model asked "do these contradict?" would be answering in the same turn it is
 * being evaluated in, and ADR 0001 keeps this layer deterministic.
 */
export function sameSubject(a: string, b: string): boolean {
  const left = subjectWords(a);
  const right = subjectWords(b);
  let shared = 0;
  let substantial = 0;
  for (const word of left) {
    if (!right.has(word)) continue;
    shared += 1;
    if (word.length >= 6) substantial += 1;
  }
  return shared >= 2 && substantial >= 1;
}

function subjectWords(text: string): ReadonlySet<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3) continue;
    if (STOP_WORDS.has(raw)) continue;
    words.add(raw);
  }
  return words;
}

function clean(value: string, limit: number): string {
  return redactSecrets(value.trim()).slice(0, limit);
}

function cleanList(values: readonly string[] | undefined, limit: number, perItem: number): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  const result: string[] = [];
  for (const value of values.slice(0, limit)) {
    const normalized = clean(value, perItem);
    if (normalized.length === 0) continue;
    if (result.includes(normalized)) continue;
    result.push(normalized);
  }
  return Object.freeze(result);
}

/** A claim and its citations, normalized and bounded, before any of it is believed. */
interface NormalizedClaim {
  readonly claim: string;
  readonly evidence: readonly string[];
}

function normalizeClaims(values: readonly FindingClaim[] | undefined, limit: number): readonly NormalizedClaim[] {
  if (values === undefined) return Object.freeze([]);
  const result: NormalizedClaim[] = [];
  for (const value of values.slice(0, limit)) {
    const claim = clean(typeof value === "string" ? value : value.claim, MAX_FINDING_CHARS);
    if (claim.length === 0) continue;
    const evidence = Object.freeze((typeof value === "string" ? [] : (value.evidence ?? []))
      .map((item) => clean(item, MAX_PATH_CHARS))
      .filter((item) => item.length > 0)
      .slice(0, MAX_EVIDENCE_PER_FINDING));
    result.push(Object.freeze({ claim, evidence }));
  }
  return Object.freeze(result);
}

/** One accepted finding, as the belief BrainGate will hand on. Evidence is required, not optional. */
function acceptedFinding(input: {
  readonly claim: string;
  readonly evidence: readonly string[];
  readonly assertedBy: string;
  readonly recordedAt: string;
  readonly findingId: string;
}): Finding {
  return Object.freeze({
    findingId: input.findingId,
    status: "accepted" as const,
    claim: input.claim,
    // A claim with nothing behind it is accepted on the word of whoever asserted it, and saying so
    // is the honest record. An empty evidence list would read as "no basis given", which is a
    // different and weaker statement than "the operator said so".
    evidence: Object.freeze(input.evidence.length === 0 ? [`asserted-by:${input.assertedBy}`] : input.evidence),
    assertedBy: input.assertedBy,
    conflictsWith: null,
    supersededBy: null,
    recordedAt: input.recordedAt,
  });
}

export interface ApplyGoalStateInput {
  readonly current: GoalState;
  readonly update: import("./types.js").GoalStateUpdate;
  /** Stable id for each finding created by this update; injected so a store and a test agree. */
  readonly findingId: () => string;
  readonly recordedAt: string;
}

/**
 * Folds one update into a goal's state, without letting a worker rewrite an established belief.
 *
 * The rule that matters: an incoming finding that overlaps an accepted one is recorded as
 * `conflicting` and the accepted finding is left exactly as it was. That is the SaudiGPT failure
 * made unrepresentable — Haiku's "token refresh fragmentation is the root cause" would have landed
 * beside the splash-race finding with its evidence intact, and the next reader would have seen two
 * claims and one of them labelled as the one with support, instead of seeing only the second one.
 *
 * Acceptance is not inferred from confidence, fluency or a model's say-so. A finding becomes
 * accepted when it arrives in `acceptedFindings`, which is a decision made above this function —
 * by the operator, or by the part of a run that has evidence. Because accepting is therefore
 * explicit, a claim that arrives to *replace* an accepted finding is refused here rather than
 * arbitrated: replacing a belief is reconciliation, and reconciliation is a later milestone.
 *
 * Repeating something already established is neither acceptance nor a dispute. A worker that
 * confirms the diagnosis it was handed must not manufacture a disagreement with itself.
 */
export function applyGoalStateUpdate(input: ApplyGoalStateInput): GoalState {
  const { current, update } = input;
  const assertedBy = clean(update.assertedBy ?? "unknown", 120);
  const accepted = [...current.acceptedFindings];
  const secondary = [...current.secondaryFindings];
  const disputed = [...current.disputedFindings];

  const known = (claim: string): Finding | undefined =>
    accepted.find((finding) => sameSubject(finding.claim, claim)) ?? secondary.find((finding) => sameSubject(finding.claim, claim));
  const alreadyDisputed = (claim: string): boolean => disputed.some((finding) => sameSubject(finding.claim, claim));

  for (const proposed of normalizeClaims(update.acceptedFindings, MAX_ACCEPTED_FINDINGS)) {
    const established = known(proposed.claim);
    if (established === undefined) {
      accepted.push(acceptedFinding({ ...proposed, assertedBy, recordedAt: input.recordedAt, findingId: input.findingId() }));
      continue;
    }
    // The same subject, and possibly the same sentence. Only a *different* claim is a disagreement;
    // restating what is already established adds nothing and disputes nothing.
    if (normalizedEquals(established.claim, proposed.claim) || alreadyDisputed(proposed.claim)) continue;
    disputed.push(Object.freeze({
      findingId: input.findingId(),
      status: "conflicting" as const,
      claim: proposed.claim,
      evidence: proposed.evidence,
      assertedBy,
      conflictsWith: established.findingId,
      supersededBy: null,
      recordedAt: input.recordedAt,
    }));
  }

  for (const proposed of normalizeClaims(update.secondaryFindings, MAX_SECONDARY_FINDINGS)) {
    if (known(proposed.claim) !== undefined) continue;
    secondary.push(acceptedFinding({ ...proposed, assertedBy, recordedAt: input.recordedAt, findingId: input.findingId() }));
  }

  return Object.freeze({
    status: update.status ?? current.status,
    acceptedFindings: Object.freeze(accepted.slice(0, MAX_ACCEPTED_FINDINGS)),
    secondaryFindings: Object.freeze(secondary.slice(0, MAX_SECONDARY_FINDINGS)),
    disputedFindings: Object.freeze(disputed.slice(0, MAX_DISPUTED_FINDINGS)),
    openQuestions: update.openQuestions === undefined ? current.openQuestions : cleanList(update.openQuestions, MAX_OPEN_QUESTIONS, MAX_FIELD_CHARS),
    approvedScope: update.approvedScope === undefined ? current.approvedScope : cleanList(update.approvedScope, MAX_SCOPE_ENTRIES, MAX_PATH_CHARS),
    filesChanged: update.filesChanged === undefined ? current.filesChanged : cleanList(update.filesChanged, MAX_FILES_CHANGED, MAX_PATH_CHARS),
    testsRun: update.testsRun === undefined ? current.testsRun : cleanList(update.testsRun, MAX_TESTS_RUN, MAX_FIELD_CHARS),
    nextAction: update.nextAction === undefined ? current.nextAction : (update.nextAction === null ? null : clean(update.nextAction, MAX_NEXT_ACTION_CHARS) || null),
    providerSessions: current.providerSessions,
  });
}

function normalizedEquals(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The one spelling of "nothing has happened here yet". */
export const EMPTY_GOAL_STATE: GoalState = Object.freeze({
  status: "open" as const,
  acceptedFindings: Object.freeze([]),
  secondaryFindings: Object.freeze([]),
  disputedFindings: Object.freeze([]),
  openQuestions: Object.freeze([]),
  approvedScope: Object.freeze([]),
  filesChanged: Object.freeze([]),
  testsRun: Object.freeze([]),
  nextAction: null,
  providerSessions: Object.freeze([]),
});

export function findingsWithStatus(state: GoalState, status: FindingStatus): readonly Finding[] {
  switch (status) {
    case "accepted": return state.acceptedFindings;
    case "conflicting": return state.disputedFindings;
    default: return Object.freeze([]);
  }
}
