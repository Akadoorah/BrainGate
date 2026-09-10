import type { TaskComplexity, TaskRisk } from "./task-ledger.js";

// Bumped because the rules changed, not the code: a receipt written under the old version
// classified a read-only question about a sensitive area three tiers higher than this one does.
export const CLASSIFIER_RULE_VERSION = "2026-09-09.1";

export type TaskMode = "ask" | "write" | "review";

export interface InspectionSignals {
  readonly affectedFiles?: number;
  readonly crossRepo?: boolean;
  readonly publicApi?: boolean;
  readonly databaseSchema?: boolean;
  readonly auth?: boolean;
  readonly payments?: boolean;
  readonly production?: boolean;
  readonly destructive?: boolean;
  readonly security?: boolean;
  readonly testsMissing?: boolean;
  readonly simpleCauseConfirmed?: boolean;
}

export interface ClassificationInput {
  readonly text: string;
  readonly mode?: TaskMode;
  readonly inspection?: InspectionSignals;
}

export interface TaskClassification {
  readonly complexity: TaskComplexity;
  readonly risk: TaskRisk;
  readonly confidence: number;
  readonly requiresScout: boolean;
  readonly reasons: readonly string[];
  readonly sensitiveDomains: readonly string[];
  readonly ruleVersion: string;
}

const COMPLEXITY_ORDER: readonly TaskComplexity[] = ["T0", "T1", "T2", "T3", "T4"];
const RISK_ORDER: readonly TaskRisk[] = ["low", "medium", "high", "critical"];

const QUESTION_TERMS = ["where is", "what does", "explain", "find", "which file", "وين", "اين", "أين", "شو", "ما هو", "اشرح", "دور لي"];
const WRITE_TERMS = ["add", "implement", "create", "change", "fix", "rename", "refactor", "اضف", "أضف", "نفذ", "سوي", "غير", "غيّر", "اصلح", "أصلح"];
const DEBUG_TERMS = ["bug", "error", "fails", "broken", "debug", "race condition", "مشكله", "مشكلة", "خطا", "خطأ", "باق", "ما يشتغل", "لا يعمل"];
const ARCHITECTURE_TERMS = ["architecture", "redesign", "rewrite", "multi-tenant", "multi tenant", "cross-repo", "migration", "migrate", "معمار", "اعادة بناء", "إعادة بناء", "ترحيل", "مايغريشن"];
/**
 * Cues that a question ranges over a codebase rather than pointing at a place in it.
 *
 * Breadth is a cost driver on its own, separate from risk. "What do you think about paywalls
 * in the app" is not dangerous, but answering it means reading widely, and a task budgeted like
 * a lookup runs out of tool-use turns before it reaches an answer. The classifier had no signal
 * for this at all, so it rated a whole-application review below "where is X implemented".
 */
/**
 * Asking for a judgement rather than a fact: an opinion, an assessment, an audit.
 *
 * A named list because it was written inline, as a subset of the breadth terms with its own
 * quiet drift — the English half had `audit` and the Arabic half had only opinion words, so the
 * same audit request reached T3 in one language and T2 in the other. Two copies of a vocabulary
 * are two vocabularies.
 */
const JUDGEMENT_TERMS = [
  "what do you think", "your opinion", "assess", "evaluate", "tradeoff", "trade-off", "compare", "audit",
  "ما رأيك", "رأيك", "رايك", "قيّم", "مقارنة", "افحص", "فحص", "تدقيق", "دقق", "راجع", "مراجعة", "تحليل",
];

const BREADTH_TERMS = [
  "across the", "throughout", "whole app", "whole application", "entire app", "entire codebase",
  "overall", "in general", "generally", "everywhere", "all the", "every ",
  "what do you think", "your opinion", "assess", "evaluate", "tradeoff", "trade-off",
  "approach to", "strategy", "compare", "audit",
  "بشكل عام", "عامة", "عموما", "عموماً", "بالتطبيق", "في التطبيق", "كل ال", "ما رأيك", "رايك", "رأيك", "قيّم", "قيم ", "استراتيجية", "مقارنة",
  // Auditing words, which the English list has had from the start and the Arabic list did not.
  // Measured on a real request: the same audit of a real API surface classified T3 in English
  // and T1 in Arabic — the cheapest model, no planning pass, no reviewer. An operator who works
  // in Arabic was being quietly under-budgeted for exactly the kind of task that needs the most.
  "افحص", "فحص", "تدقيق", "دقق", "راجع", "مراجعة", "تغطية", "نقص", "تسلسل", "شامل", "شاملة", "بالكامل", "جميع ", "تحليل",
];

const FEATURE_TERMS = ["feature", "refactor", "integration", "endpoint", "workflow", "ميزة", "خاصية", "تكامل", "واجهة"];

const DOMAIN_TERMS = {
  payments: ["payment", "billing", "stripe", "subscription", "charge", "refund", "checkout", "دفع", "فوترة", "اشتراك", "خصم", "سترايب", "فاتورة", "مدفوعات"],
  auth: ["auth", "login", "oauth", "jwt", "token", "password", "permission", "role", "تسجيل الدخول", "مصادقة", "توكن", "كلمة المرور", "صلاحيات"],
  database: ["database", "schema", "migration", "migrate", "sql", "database migration", "قاعدة البيانات", "داتا بيس", "سكيمة", "ترحيل", "مايغريشن"],
  production: ["production", "prod", "deploy", "release", "live environment", "برودكشن", "انتاج", "إنتاج", "نشر", "ديبلوي"],
  security: ["security", "vulnerability", "secret", "credential", "encryption", "امن", "أمن", "ثغرة", "سر", "مفتاح", "تشفير"],
  destructive: ["delete", "drop", "truncate", "wipe", "remove all", "حذف", "احذف", "امسح", "مسح كامل", "دروب"],
} as const;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(normalize(term)));
}

function maxComplexity(a: TaskComplexity, b: TaskComplexity): TaskComplexity {
  return COMPLEXITY_ORDER[Math.max(COMPLEXITY_ORDER.indexOf(a), COMPLEXITY_ORDER.indexOf(b))]!;
}

function maxRisk(a: TaskRisk, b: TaskRisk): TaskRisk {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(a), RISK_ORDER.indexOf(b))]!;
}

function detectDomains(text: string, inspection?: InspectionSignals): Set<string> {
  const domains = new Set<string>();
  if (hasAny(text, DOMAIN_TERMS.payments) || inspection?.payments) domains.add("payments");
  if (hasAny(text, DOMAIN_TERMS.auth) || inspection?.auth) domains.add("auth");
  if (hasAny(text, DOMAIN_TERMS.database) || inspection?.databaseSchema) domains.add("database");
  if (hasAny(text, DOMAIN_TERMS.production) || inspection?.production) domains.add("production");
  if (hasAny(text, DOMAIN_TERMS.security) || inspection?.security) domains.add("security");
  if (hasAny(text, DOMAIN_TERMS.destructive) || inspection?.destructive) domains.add("destructive");
  return domains;
}

export function classifyTask(input: ClassificationInput): TaskClassification {
  const text = normalize(input.text);
  const mode = input.mode ?? "ask";
  const inspection = input.inspection;
  const reasons: string[] = [];
  let complexity: TaskComplexity = "T1";
  let risk: TaskRisk = "low";
  let confidence = 0.55;

  if (text.length === 0) {
    return {
      complexity: "T1",
      risk: "low",
      confidence: 0.3,
      requiresScout: true,
      reasons: ["empty-or-ambiguous-request"],
      sensitiveDomains: [],
      ruleVersion: CLASSIFIER_RULE_VERSION,
    };
  }

  if (text.length <= 120 && hasAny(text, QUESTION_TERMS)) {
    complexity = "T0";
    confidence = 0.85;
    reasons.push("small-question-cue");
  }

  if (mode === "write") {
    complexity = maxComplexity(complexity, "T2");
    confidence = Math.max(confidence, 0.9);
    reasons.push("write-requested");
  } else if (mode === "review") {
    complexity = maxComplexity(complexity, "T2");
    confidence = Math.max(confidence, 0.88);
    reasons.push("review-requested");
  }

  // Applied before the cue chain below so a broad question cannot be pinned back down to T0 by
  // also containing a question word: "what do you think about X in the app" contains both.
  const broad = hasAny(text, BREADTH_TERMS);
  if (broad) {
    complexity = maxComplexity(complexity, "T2");
    confidence = Math.max(confidence, 0.75);
    reasons.push("breadth-cue");
  }

  if (hasAny(text, ARCHITECTURE_TERMS)) {
    complexity = "T4";
    confidence = Math.max(confidence, 0.95);
    reasons.push("architecture-or-migration-cue");
  } else if (hasAny(text, DEBUG_TERMS)) {
    complexity = maxComplexity(complexity, "T2");
    confidence = Math.max(confidence, 0.82);
    reasons.push("debugging-cue");
  } else if ((hasAny(text, FEATURE_TERMS) || hasAny(text, WRITE_TERMS)) && !(mode === "ask" && reasons.includes("small-question-cue"))) {
    // A short question that happens to contain an implementation word is still a question:
    // "where is the paywall logic implemented?" asks about code that exists, and rating it as
    // implementation work gave a lookup more budget than a whole-application review.
    complexity = maxComplexity(complexity, "T2");
    confidence = Math.max(confidence, 0.8);
    reasons.push("implementation-cue");
  }

  if (inspection?.affectedFiles !== undefined) {
    if (!Number.isInteger(inspection.affectedFiles) || inspection.affectedFiles < 0) {
      throw new RangeError("affectedFiles must be a non-negative integer");
    }
    if (inspection.affectedFiles >= 40) complexity = maxComplexity(complexity, "T4");
    else if (inspection.affectedFiles >= 15) complexity = maxComplexity(complexity, "T3");
    else if (inspection.affectedFiles >= 5) complexity = maxComplexity(complexity, "T2");
    reasons.push(`affected-files:${inspection.affectedFiles}`);
    confidence = Math.max(confidence, 0.92);
  }

  if (inspection?.crossRepo) {
    complexity = "T4";
    reasons.push("cross-repo-impact");
    confidence = Math.max(confidence, 0.96);
  }
  if (inspection?.publicApi) {
    complexity = maxComplexity(complexity, "T3");
    reasons.push("public-api-impact");
  }
  if (inspection?.databaseSchema) {
    complexity = maxComplexity(complexity, "T3");
    reasons.push("database-schema-impact");
  }
  if (inspection?.testsMissing) {
    risk = maxRisk(risk, "medium");
    reasons.push("tests-missing");
  }

  const domains = detectDomains(text, inspection);
  /**
   * Risk is what a task could damage, and a question damages nothing.
   *
   * "Where is the authentication logic?" opens no worktree, changes no file and merges nothing,
   * yet naming a sensitive area was enough to make it high risk — which forces T3, which buys a
   * planner and a required reviewer for a one-line lookup. The domain is still worth recording:
   * it drives redaction, it appears in the receipt, and it is the reason a second opinion is
   * *offered*. It is not a reason to pay for one. In write and review mode the floor is
   * unchanged, because there the task really can break the thing it names.
   */
  const canDamage = mode !== "ask";
  const domainRisk: TaskRisk = canDamage ? "high" : "medium";
  if (domains.has("payments") || domains.has("auth") || domains.has("database") || domains.has("production") || domains.has("security")) {
    risk = maxRisk(risk, domainRisk);
  }
  if (domains.has("destructive")) {
    risk = maxRisk(risk, domainRisk);
  }
  if (
    canDamage && (
      (domains.has("payments") && mode === "write") ||
      (domains.has("destructive") && (domains.has("database") || domains.has("production") || domains.has("auth")))
    )
  ) {
    risk = "critical";
  }

  for (const domain of domains) reasons.push(`sensitive-domain:${domain}`);

  // A broad question that also asks for a judgement — an opinion, an assessment, a comparison —
  // has to survey before it can conclude, which is the most turn-hungry shape a read task takes.
  if (broad && hasAny(text, JUDGEMENT_TERMS)) {
    complexity = maxComplexity(complexity, "T3");
    reasons.push("open-ended-judgement");
  }

  if (risk === "high") complexity = maxComplexity(complexity, "T3");
  if (risk === "critical") complexity = "T4";

  const broadImpact = Boolean(
    inspection?.crossRepo || inspection?.publicApi || inspection?.databaseSchema || (inspection?.affectedFiles ?? 0) >= 5,
  );
  if (inspection?.simpleCauseConfirmed && !broadImpact && risk === "low") {
    complexity = mode === "write" ? "T2" : "T1";
    confidence = Math.max(confidence, 0.96);
    reasons.push("simple-cause-confirmed");
  }

  const requiresScout = confidence < 0.7 || COMPLEXITY_ORDER.indexOf(complexity) >= COMPLEXITY_ORDER.indexOf("T2");
  return {
    complexity,
    risk,
    confidence: Math.round(confidence * 100) / 100,
    requiresScout,
    reasons: Object.freeze(reasons),
    sensitiveDomains: Object.freeze([...domains].sort()),
    ruleVersion: CLASSIFIER_RULE_VERSION,
  };
}

export function reclassifyTask(previous: TaskClassification, input: ClassificationInput): TaskClassification {
  const next = classifyTask(input);
  const previousIndex = COMPLEXITY_ORDER.indexOf(previous.complexity);
  const nextIndex = COMPLEXITY_ORDER.indexOf(next.complexity);
  const simpleCause = input.inspection?.simpleCauseConfirmed === true;
  const minimumIndex = simpleCause ? 0 : Math.max(0, previousIndex - 1);
  const controlledComplexity = COMPLEXITY_ORDER[Math.max(nextIndex, minimumIndex)]!;

  const previousRiskIndex = RISK_ORDER.indexOf(previous.risk);
  const nextRiskIndex = RISK_ORDER.indexOf(next.risk);
  const stickyRisk = previousRiskIndex >= RISK_ORDER.indexOf("high");
  const controlledRisk = stickyRisk && nextRiskIndex < previousRiskIndex ? previous.risk : next.risk;
  let riskAdjustedComplexity = controlledComplexity;
  if (controlledRisk === "high") riskAdjustedComplexity = maxComplexity(riskAdjustedComplexity, "T3");
  if (controlledRisk === "critical") riskAdjustedComplexity = "T4";

  return {
    ...next,
    complexity: riskAdjustedComplexity,
    risk: controlledRisk,
    reasons: Object.freeze([
      ...next.reasons,
      ...(controlledComplexity !== next.complexity ? ["downgrade-limited"] : []),
      ...(controlledRisk !== next.risk ? ["high-risk-sticky"] : []),
      ...(riskAdjustedComplexity !== controlledComplexity ? ["risk-floor-restored"] : []),
    ]),
  };
}
