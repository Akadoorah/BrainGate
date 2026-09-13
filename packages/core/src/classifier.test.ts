import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask, reclassifyTask } from "./classifier.js";
import { COMPLEXITY_ORDER } from "./classifier.js";
import { budgetFor } from "./budget.js";

test("tiny Arabic question stays cheap", () => {
  const result = classifyTask({ text: "وين ملف اللوجو؟", mode: "ask" });
  assert.equal(result.complexity, "T0");
  assert.equal(result.risk, "low");
  assert.equal(result.requiresScout, false);
});

test("ordinary write becomes T2 without raising risk", () => {
  const result = classifyTask({ text: "Add a settings page", mode: "write" });
  assert.equal(result.complexity, "T2");
  assert.equal(result.risk, "low");
  assert.equal(result.requiresScout, true);
});

test("Arabic payment write becomes critical T4", () => {
  const result = classifyTask({ text: "غير نظام الدفع والاشتراكات حتى ما يصير خصم مرتين", mode: "write" });
  assert.equal(result.complexity, "T4");
  assert.equal(result.risk, "critical");
  assert.ok(result.sensitiveDomains.includes("payments"));
});

// Risk is what a task could damage. Reading about authentication damages nothing — no worktree
// is opened, no file changes, nothing merges — and pricing the question as if it did bought a
// planner and a required reviewer for a one-line lookup.
test("a question about a sensitive area records the domain without paying for a change", () => {
  for (const text of ["where is the authentication logic?", "ليش تسجيل الدخول أحيانا يطلع المستخدم؟"]) {
    const result = classifyTask({ text, mode: "ask" });
    assert.ok(result.sensitiveDomains.includes("auth"), `${text} must still record the domain`);
    assert.equal(result.risk, "medium", "the domain is worth noting, not worth a high-risk floor");
    assert.notEqual(result.complexity, "T3");
    assert.notEqual(result.complexity, "T4");
  }
});

test("a change to the same area keeps the floor the question does not get", () => {
  const change = classifyTask({ text: "add oauth login to the settings screen", mode: "write" });
  assert.equal(change.risk, "high");
  assert.equal(change.complexity, "T3");

  // Review mode judges a change that already exists, so it carries the change's risk.
  const review = classifyTask({ text: "review this change to the auth guard", mode: "review" });
  assert.equal(review.risk, "high");

  // And the critical combinations still are.
  assert.equal(classifyTask({ text: "delete all user accounts from the production database", mode: "write" }).risk, "critical");
  assert.equal(classifyTask({ text: "change the stripe subscription price", mode: "write" }).risk, "critical");
});

test("a sensitive question can be reviewed on request, without being reviewed by default", () => {
  // The middle ground the old rule had no room for: either one call with no reviewer reachable,
  // or four calls with a planner. A second opinion on an auth answer is worth offering.
  const budget = budgetFor(classifyTask({ text: "where is the authentication logic?", mode: "ask" }), { writeRequested: false });
  assert.equal(budget.reviewerPolicy, "optional");
  assert.equal(budget.separatePlanningPass, false);
  assert.ok(budget.maxReviewers >= 1, "asking for --review must be able to do something");
});

test("inspection escalates hidden impact", () => {
  const initial = classifyTask({ text: "Rename this field", mode: "write" });
  assert.equal(initial.complexity, "T2");
  const inspected = reclassifyTask(initial, {
    text: "Rename this field",
    mode: "write",
    inspection: { affectedFiles: 22, publicApi: true },
  });
  assert.equal(inspected.complexity, "T3");
});

test("confirmed simple cause can de-escalate a generic bug", () => {
  const initial = classifyTask({ text: "I have a weird bug and it is broken", mode: "ask" });
  assert.equal(initial.complexity, "T2");
  const inspected = reclassifyTask(initial, {
    text: "I have a weird bug and it is broken",
    mode: "ask",
    inspection: { affectedFiles: 1, simpleCauseConfirmed: true },
  });
  assert.equal(inspected.complexity, "T1");
  assert.equal(inspected.risk, "low");
});

test("high risk stays sticky and restores its complexity floor", () => {
  const initial = classifyTask({ text: "Review auth token handling", mode: "review" });
  assert.equal(initial.risk, "high");
  const next = reclassifyTask(initial, {
    text: "Review this helper",
    mode: "review",
    inspection: { affectedFiles: 1, simpleCauseConfirmed: true },
  });
  assert.equal(next.risk, "high");
  assert.equal(next.complexity, "T3");
});

test("cross-repo impact reaches T4", () => {
  const result = classifyTask({ text: "Update shared user model", mode: "write", inspection: { crossRepo: true } });
  assert.equal(result.complexity, "T4");
});

// A whole-application review was classified below "where is X implemented", so it received a
// lookup's turn budget and died with error_max_turns before reaching an answer. Breadth is a
// cost driver on its own: answering broadly means reading widely, whatever the risk.
test("a question that ranges over the codebase outranks one that points at a place in it", () => {
  const broad = classifyTask({ text: "Review the paywall approach across the whole application", mode: "ask" });
  const narrow = classifyTask({ text: "Where is the paywall logic implemented?", mode: "ask" });
  const order = ["T0", "T1", "T2", "T3", "T4"];
  assert.ok(
    order.indexOf(broad.complexity) > order.indexOf(narrow.complexity),
    `breadth must outrank a lookup: ${broad.complexity} vs ${narrow.complexity}`,
  );
  assert.ok(budgetFor(broad, { writeRequested: false }).maxInspectionTurns > budgetFor(narrow, { writeRequested: false }).maxInspectionTurns);
});

test("an open-ended judgement is recognised in either language", () => {
  // The Arabic original that failed, and its English equivalent: the cue is the shape of the
  // question, not the language it is asked in.
  for (const text of ["ما رأيك بـ Paywalls عامة في التطبيق؟", "What do you think about paywalls generally in the app?"]) {
    const classification = classifyTask({ text, mode: "ask" });
    assert.equal(classification.complexity, "T3", `expected T3 for: ${text}`);
    assert.ok(classification.reasons.includes("open-ended-judgement"), `missing the judgement cue for: ${text}`);
  }
});

test("breadth raises complexity without inventing risk", () => {
  // Reading widely is expensive, not dangerous. Inflating risk would pull in a reviewer and
  // double the cost of an ordinary question.
  assert.equal(classifyTask({ text: "What do you think about the caching approach generally?", mode: "ask" }).risk, "low");
});

test("an ordinary lookup is not inflated by the breadth signal", () => {
  for (const text of ["Where is the theme configuration defined?", "وين معرّف إعداد الثيم؟", "What Node version does this need?"]) {
    const classification = classifyTask({ text, mode: "ask" });
    assert.ok(["T0", "T1"].includes(classification.complexity), `${text} became ${classification.complexity}`);
  }
});

test("the same audit is budgeted the same way in Arabic as in English", () => {
  // Measured on a real request against a real API surface: this classified T3 in English and T1
  // in Arabic, which bought the cheapest model, no planning pass and no reviewer for exactly the
  // kind of task that needs all three. The lists had Arabic; they were missing its audit words.
  const english = classifyTask({
    text: "Audit the API surface end to end: enumerate every endpoint, establish the order they are called in, and identify coverage gaps against the features currently shipped.",
    mode: "ask",
  });
  const arabic = classifyTask({
    text: "افحص تسلسل الـ API: ما نقاط النهاية الموجودة، وما ترتيب استدعائها، وهل هناك نقص في التغطية مقابل الميزات المعلنة حالياً؟",
    mode: "ask",
  });
  assert.equal(arabic.complexity, english.complexity, `Arabic ${arabic.complexity} vs English ${english.complexity}`);
  assert.ok(arabic.reasons.includes("breadth-cue"), `Arabic reasons: ${arabic.reasons.join(", ")}`);
  assert.ok(arabic.reasons.includes("open-ended-judgement"), "an audit asks for a judgement in either language");
});

test("an Arabic review or coverage request reads as broad, like its English counterpart", () => {
  for (const text of [
    "راجع تغطية الاختبارات في المشروع",
    "دقق في تسلسل الاستدعاءات بين الواجهة والخادم",
    "حلل النقص في معالجة الأخطاء بالكامل",
  ]) {
    const classification = classifyTask({ text, mode: "ask" });
    assert.ok(
      classification.reasons.includes("breadth-cue"),
      `"${text}" read as ${classification.complexity} with reasons: ${classification.reasons.join(", ")}`,
    );
  }
});

// ---------------------------------------------------------------- risk is about the artifact

/**
 * Real dogfood rated a Markdown comment a database migration, twice over.
 *
 * ```text
 * Apply the agreed harmless comment-only change to the selected README file:
 * flutter_migration/…/LaunchImage.imageset/README.md
 * … do not use git checkout …
 * ```
 *
 * `flutter_migration` contains `migration` (substring match → T4, `sensitive-domain:database`), and
 * `do not use git checkout` contains `checkout` (a payments term → `sensitive-domain:payments`). The
 * request was refused with WRITE_SCOPE_BLOCKED before a task existed, and the operator was told a
 * Markdown file was high-risk migration work.
 *
 * Risk now follows the requested effect and the artifact it names. These cases are the boundary in
 * both directions, and the safety gate they feed (`assertM11Scope`) is unchanged.
 */
const DOGFOOD_WRITE = [
  "Apply the agreed harmless comment-only change to the selected README file:",
  "flutter_migration/tabaq_onboarding/ios/Runner/Assets.xcassets/LaunchImage.imageset/README.md",
  "",
  "Append one inert comment line:",
  "<!-- DIRECT-mode test marker: no functional content changed -->",
  "",
  "Modify only that file, do not commit, do not create a branch,",
  "do not use git reset, do not use git clean, do not use git stash, do not use git checkout,",
  "and report exactly which file changed.",
].join("\n");

test("A: a comment in a README under flutter_migration is an ordinary T2 write", () => {
  const classification = classifyTask({ text: DOGFOOD_WRITE, mode: "write" });
  assert.equal(classification.complexity, "T2");
  assert.equal(classification.risk, "low");
  assert.ok(classification.reasons.includes("documentation-only"));
  assert.equal(classification.reasons.some((reason) => reason.startsWith("sensitive-domain:")), false, "a path name is not a domain");
  assert.equal(classification.reasons.includes("architecture-or-migration-cue"), false, "and a project named flutter_migration is not a migration");
});

test("B: a real schema migration is still architecture-level and high risk", () => {
  const classification = classifyTask({ text: "Apply this to migrations/001_add_users.sql: ALTER TABLE users ADD COLUMN email TEXT;", mode: "write" });
  assert.equal(classification.complexity, "T4");
  assert.equal(classification.risk, "high");
  assert.ok(classification.reasons.includes("sensitive-domain:database"));
  assert.ok(classification.reasons.includes("artifact:schema"));
});

test("C/E: documentation under a sensitive directory name is still documentation", () => {
  for (const text of ["Fix a typo in security/README.md. Do not commit.", "Update the wording in payments/README.md. Do not commit.", "Add a note to auth/docs/notes.md."]) {
    const classification = classifyTask({ text, mode: "write" });
    assert.equal(classification.risk, "low", text);
    assert.ok(classification.complexity === "T1" || classification.complexity === "T2", text);
    assert.equal(classification.reasons.some((reason) => reason.startsWith("sensitive-domain:")), false, text);
  }
});

test("D/F: code in a sensitive area is still sensitive, from what the file is", () => {
  const auth = classifyTask({ text: "Change the authentication acceptance logic in auth/login.ts.", mode: "write" });
  assert.equal(auth.risk, "high");
  assert.ok(COMPLEXITY_ORDER.indexOf(auth.complexity) >= COMPLEXITY_ORDER.indexOf("T3"));
  assert.ok(auth.reasons.includes("sensitive-domain:auth"));

  const payments = classifyTask({ text: "Change the charge and refund behaviour in payments/processor.ts.", mode: "write" });
  assert.equal(payments.risk, "critical");
  assert.equal(payments.complexity, "T4");
  assert.ok(payments.reasons.includes("sensitive-domain:payments"));
});

test("a constraint about a git command is not payment work", () => {
  // `checkout` is a payments word and a git command; only the second reading is available here.
  const withConstraint = classifyTask({ text: "Append a comment to docs/README.md. Do not use git checkout or git reset.", mode: "write" });
  assert.equal(withConstraint.reasons.some((reason) => reason === "sensitive-domain:payments"), false);
  // Asked for, rather than forbidden, it is still payment work.
  const realWork = classifyTask({ text: "Fix the checkout flow in payments/checkout.ts.", mode: "write" });
  assert.equal(realWork.risk, "critical");
});

test("G: a path containing 'migration' says nothing about a read", () => {
  const classification = classifyTask({ text: "Explain what flutter_migration/tabaq_onboarding/README.md documents.", mode: "ask" });
  assert.equal(classification.risk, "low");
  assert.equal(classification.reasons.some((reason) => reason.startsWith("sensitive-domain:")), false);
});

test("a domain word that merely contains another domain word is not that domain", () => {
  // `session` is an auth word; `subscription` is a payments word. Both are real, and neither makes
  // the other fire from a substring.
  const payments = classifyTask({ text: "Change the subscription renewal date in billing/plan.ts.", mode: "write" });
  assert.ok(payments.reasons.includes("sensitive-domain:payments"));
  assert.equal(payments.reasons.includes("sensitive-domain:auth"), false);
});
