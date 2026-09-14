import type { TaskComplexity, TaskRisk } from "./task-outcome.js";
import { PATH_TOKEN, classifyArtifacts, type ArtifactAssessment } from "./artifact.js";

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

export const COMPLEXITY_ORDER: readonly TaskComplexity[] = ["T0", "T1", "T2", "T3", "T4"];
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
  // The verb forms of the same cues, which is how a request is actually phrased: "قارن" is compare
  // as an instruction and "مقارنة" is comparison as a subject, and only the first was listed.
  "قارن", "بالتفصيل", "تفصيل", "تتبع", "حلل", "تحقق", "استقص", "افهم",
];

const FEATURE_TERMS = ["feature", "refactor", "integration", "endpoint", "workflow", "ميزة", "خاصية", "تكامل", "واجهة"];

const DOMAIN_TERMS = {
  payments: ["payment", "payments", "billing", "stripe", "subscription", "subscriptions", "charge", "charges", "charged", "refund", "refunds", "checkout", "invoice", "invoices", "دفع", "فوترة", "اشتراك", "خصم", "سترايب", "فاتورة", "مدفوعات"],
  auth: ["auth", "authentication", "authenticate", "authorization", "authorize", "login", "signin", "oauth", "jwt", "token", "password", "permission", "permissions", "role", "roles", "session", "تسجيل الدخول", "مصادقة", "توكن", "كلمة المرور", "صلاحيات"],
  database: ["database", "schema", "migration", "migrations", "migrate", "sql", "database migration", "قاعدة البيانات", "داتا بيس", "سكيمة", "ترحيل", "مايغريشن"],
  production: ["production", "prod", "deploy", "deploys", "deployment", "deployments", "release", "releases", "live environment", "برودكشن", "انتاج", "إنتاج", "نشر", "ديبلوي"],
  security: ["security", "secure", "vulnerability", "vulnerabilities", "secret", "secrets", "credential", "credentials", "encryption", "encrypt", "امن", "أمن", "ثغرة", "سر", "مفتاح", "تشفير"],
  destructive: ["delete", "deletes", "drop", "drops", "truncate", "wipe", "remove all", "حذف", "احذف", "امسح", "مسح كامل", "دروب"],
} as const;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The sentences of a request, so a cue is read where it appears rather than across the whole text.
 *
 * Splitting on sentence punctuation and newlines is what keeps a paragraph of background apart from
 * the line that asks for something — "Here is the background… The payment migration touched the
 * checkout path. What does the delete handler do?" is one request and three sentences, and only one
 * of them is the request.
 */
function sentences(text: string): readonly string[] {
  return Object.freeze(
    text
      .split(/[\n;•]|(?<=[.!?…])\s+|[؟?]\s*/u)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0),
  );
}

/** Words, which is the comparable unit of size across scripts in a way characters are not. */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * The part of a request that asks for something, which is where scope cues belong.
 *
 * Scope is a property of the *request*, not of everything the operator wrote around it. Measured on
 * a real prompt: a one-line question — "What does the delete handler do?" — preceded by three
 * sentences of background mentioning a payment migration classified T4, because the cue chain read
 * the word `migration` out of the context. The same shape in Arabic classified T0 in English's
 * absence of cues and T4 with them. Either way the model that answered was chosen for the
 * background, not for the question.
 *
 * So the cue chain below reads the sentences that carry the request: a question in ask mode, a
 * write verb in write and review modes, a question or an implementation verb otherwise. When no
 * sentence qualifies — an unusual request, or one phrased in a way these cues do not recognise —
 * the whole text is used, because falling back to everything is the conservative direction: it can
 * only ever ask for more budget than the request needs, never less.
 */
function requestedText(text: string, mode: TaskMode): string {
  const parts = sentences(text);
  if (parts.length <= 1) return text;
  const cues = mode === "ask" ? QUESTION_TERMS : [...WRITE_TERMS, ...FEATURE_TERMS, ...QUESTION_TERMS];
  const asking = parts.filter((sentence) => hasAny(sentence, cues));
  return asking.length === 0 ? text : asking.join(" ");
}

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(normalize(term)));
}

/**
 * A cue that has to *start* a word.
 *
 * `hasAny` is a substring test, and that is right for phrases ("every ", "across the"). It is wrong
 * for domain and architecture cues, and real dogfood showed both halves of the mistake in one
 * request: `flutter_migration` contains `migration`, so a Markdown comment was rated a database
 * migration and raised to T4. A project named `flutter_migration` is a name, not an operation, and
 * a cue that only ever matched inside a longer identifier was never evidence of anything.
 *
 * Both ends are anchored. Leaving the suffix open was the same mistake one level up: `auth` matched
 * `author` and `key` matched `keyboard`, so a request about an author byline read as authentication
 * work. The inflections that mean the domain — `authentication`, `charges`, `migrations`, `deploys` —
 * are listed as the words they are, which is a vocabulary rather than a guess about where a word ends.
 */
function hasCue(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => {
    const cue = normalize(term).trim();
    if (cue.length === 0) return false;
    // A cue that is not Latin text keeps plain substring matching. Arabic attaches its definite
    // article and its conjunctions to the word — `الدفع`, `والاشتراكات` — so a word-start rule that
    // is right for `flutter_migration` silently stopped the classifier seeing payment work in
    // Arabic, which is a real request in this product and not a false positive to trade away.
    if (!/^[\x20-\x7e]+$/.test(cue)) return text.includes(cue);
    const escaped = cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "u").test(text);
  });
}

/**
 * The request with its negative constraints removed.
 *
 * "Do not commit, do not create a branch, do not use git checkout" is a boundary on *how* the change
 * is made, and it contains `checkout` — which is also a payments word. Read as evidence, the
 * constraint made a documentation edit look like payment work. A constraint says what may not
 * happen; it is not part of what is being asked for.
 */
function withoutConstraints(text: string): string {
  return text.replace(/\b(?:do not|don't|does not|doesn't|never|without|avoid)\b[^.;\n]*/gi, " ");
}

function maxComplexity(a: TaskComplexity, b: TaskComplexity): TaskComplexity {
  return COMPLEXITY_ORDER[Math.max(COMPLEXITY_ORDER.indexOf(a), COMPLEXITY_ORDER.indexOf(b))]!;
}

function maxRisk(a: TaskRisk, b: TaskRisk): TaskRisk {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(a), RISK_ORDER.indexOf(b))]!;
}

/**
 * The domains a request touches, from its wording and from the artifacts it names.
 *
 * The artifact pass is what separates a domain *word* from a domain *fact*: `auth/login.ts` is
 * authentication work because of what the file is, while a README under a directory called
 * `payments/` is documentation and contributes nothing. Paths are removed from the wording scan so a
 * directory name cannot vote twice, and the remaining prose is read with the constraints stripped.
 */
function detectDomains(text: string, artifact: ArtifactAssessment, inspection?: InspectionSignals): Set<string> {
  const domains = new Set<string>(artifact.domains);
  const prose = withoutConstraints(text.replace(PATH_TOKEN, " "));
  if (hasCue(prose, DOMAIN_TERMS.payments) || inspection?.payments) domains.add("payments");
  if (hasCue(prose, DOMAIN_TERMS.auth) || inspection?.auth) domains.add("auth");
  if (hasCue(prose, DOMAIN_TERMS.database) || inspection?.databaseSchema) domains.add("database");
  if (hasCue(prose, DOMAIN_TERMS.production) || inspection?.production) domains.add("production");
  if (hasCue(prose, DOMAIN_TERMS.security) || inspection?.security) domains.add("security");
  if (hasCue(prose, DOMAIN_TERMS.destructive) || inspection?.destructive) domains.add("destructive");
  return domains;
}

export function classifyTask(input: ClassificationInput): TaskClassification {
  const text = normalize(input.text);
  // What the request names, before anything is inferred from how it is phrased. The artifact pass
  // answers "what would change"; the cue passes below answer "what is this about".
  const artifact = classifyArtifacts(text);
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

  // "Small" is a property of the request, not of how many characters its script spends: Arabic packs
  // a substantial investigation into fewer characters than English does, and a character threshold
  // written for English rated a sixteen-word Arabic request as a lookup. Words, one sentence, and a
  // generous character ceiling for a single long sentence.
  const asked = requestedText(text, mode);
  const askedWords = wordCount(asked);
  if (askedWords <= 12 && sentences(asked).length <= 1 && asked.length <= 200 && hasAny(asked, QUESTION_TERMS)) {
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
  const broad = hasAny(asked, BREADTH_TERMS);
  if (broad) {
    complexity = maxComplexity(complexity, "T2");
    confidence = Math.max(confidence, 0.75);
    reasons.push("breadth-cue");
  }

  // A schema artifact is architecture-level work whatever the sentence says; a directory whose name
  // merely contains the word is not. Both halves are needed, and they are different questions.
  if (hasCue(withoutConstraints(asked.replace(PATH_TOKEN, " ")), ARCHITECTURE_TERMS) || artifact.schemaMigration) {
    complexity = "T4";
    confidence = Math.max(confidence, 0.95);
    reasons.push("architecture-or-migration-cue");
  } else if (hasAny(asked, DEBUG_TERMS)) {
    complexity = maxComplexity(complexity, "T2");
    confidence = Math.max(confidence, 0.82);
    reasons.push("debugging-cue");
  } else if ((hasAny(asked, FEATURE_TERMS) || hasAny(asked, WRITE_TERMS)) && !(mode === "ask" && reasons.includes("small-question-cue"))) {
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

  const domains = detectDomains(text, artifact, inspection);
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
  // The artifacts are recorded as evidence, so a refusal can be traced to what was named rather than
  // to a word that happened to appear. A documentation-only request says so in its own reason.
  if (artifact.documentationOnly) reasons.push("documentation-only");
  else if (artifact.kind !== "unknown") reasons.push(`artifact:${artifact.kind}`);

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
