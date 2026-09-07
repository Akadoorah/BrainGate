import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { conservativeTokenEstimate } from "@braingate/context";
import {
  BrainGateInvariantError,
  ProjectRegistry,
  TaskLedger,
  budgetFor,
  classifyTask,
  type RegisteredProject,
  type TaskClassification,
} from "@braingate/core";
import {
  DogfoodStore,
  applyDogfoodPrior,
  initializeDogfoodProject,
  inspectGitRepository,
  type DogfoodOutcome,
  type DogfoodReviewerVerdict,
  type DogfoodRole,
} from "@braingate/dogfood";
import { GlobalQuotaStore } from "@braingate/observability";
import { ModelCatalog, buildShadowTaskPlan, hydrateModelRegistry, resolveOperatorState, type OperatorStatePaths } from "@braingate/operator";
import { ProviderDiscovery, type ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter } from "@braingate/router";
import {
  CodexIsolationVerifier,
  ShadowDogfoodRunner,
  shadowProviderRoleStatus,
  type CodexIsolationAttestation,
  type ShadowProcessExecutor,
  type SubscriptionAttestation,
} from "@braingate/shadow";
import { WriteDogfoodRunner, assertClaudeWriteEligible, buildWriteTaskPlan, type WriteProviderExecutor } from "@braingate/write";

export interface DogfoodCliDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly discoverAll?: () => Promise<readonly ProviderSnapshot[]>;
  readonly verifyCodexIsolation?: (snapshot: ProviderSnapshot) => Promise<CodexIsolationAttestation>;
  readonly executor?: ShadowProcessExecutor;
  readonly writeExecutor?: WriteProviderExecutor;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export interface DogfoodCliResult {
  readonly exitCode: number;
  readonly data: unknown;
}

interface CodexIsolationStatus {
  readonly attempted: boolean;
  readonly eligible: boolean;
  readonly attestation: CodexIsolationAttestation | null;
  readonly reason: string | null;
}

function removeFlag(args: string[], name: string): boolean {
  let found = false;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (args[index] === name) { args.splice(index, 1); found = true; }
  }
  return found;
}

function takeOption(args: string[], name: string, required = false): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new BrainGateInvariantError("CLI_OPTION_REQUIRED", `Missing required option ${name}.`);
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new BrainGateInvariantError("CLI_OPTION_INVALID", `Option ${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function noExtraArgs(args: readonly string[]): void {
  if (args.length > 0) throw new BrainGateInvariantError("CLI_ARGUMENT_INVALID", `Unexpected CLI argument: ${args[0]}.`);
}

function safeError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof BrainGateInvariantError) return Object.freeze({ code: error.code, message: error.message });
  if (error instanceof RangeError) return Object.freeze({ code: "CLI_RANGE_ERROR", message: error.message });
  return Object.freeze({ code: "CLI_UNEXPECTED", message: "Unexpected BrainGate dogfood failure. Raw error details were suppressed." });
}

function emit(json: boolean, data: unknown, human: string, stdout: (text: string) => void): void {
  stdout(json ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);
}

function projectFromManifest(state: OperatorStatePaths, manifest: string, cwd: string): RegisteredProject {
  const registry = new ProjectRegistry(state.home);
  return registry.loadFile(resolve(cwd, manifest));
}

function manifestOption(args: string[]): string { return takeOption(args, "--project") ?? ".brain/project.json"; }
function contextTokens(task: string): number { return Math.max(128, conservativeTokenEstimate(task) + 64); }

function attestations(args: string[]): readonly SubscriptionAttestation[] {
  if (!removeFlag(args, "--attest-copilot-oauth")) return Object.freeze([]);
  const observed = new Date();
  return Object.freeze([Object.freeze({
    providerId: "github-copilot",
    mode: "subscription",
    source: "user-confirmed-oauth",
    observedAt: observed.toISOString(),
    expiresAt: new Date(observed.getTime() + 60 * 60 * 1000).toISOString(),
  })]);
}

async function discovery(deps: DogfoodCliDependencies): Promise<readonly ProviderSnapshot[]> {
  return deps.discoverAll === undefined ? await new ProviderDiscovery().discoverAll() : await deps.discoverAll();
}

function configuredOpenAi(state: OperatorStatePaths): boolean {
  return new ModelCatalog(state.modelCatalogPath).load().some((entry) => entry.configured && entry.providerId === "openai");
}

async function codexIsolationStatus(
  snapshots: readonly ProviderSnapshot[],
  deps: DogfoodCliDependencies,
  env: NodeJS.ProcessEnv,
  shouldAttempt: boolean,
): Promise<CodexIsolationStatus> {
  const snapshot = snapshots.find((item) => item.providerId === "openai");
  if (snapshot === undefined || snapshot.available.value !== true) return Object.freeze({ attempted: false, eligible: false, attestation: null, reason: "Codex CLI is unavailable." });
  if (snapshot.authState.value !== "authenticated" || snapshot.authMode.value !== "subscription") return Object.freeze({ attempted: false, eligible: false, attestation: null, reason: "ChatGPT subscription authentication is not proven by codex login status." });
  if (!shouldAttempt) return Object.freeze({ attempted: false, eligible: false, attestation: null, reason: "Codex isolation self-test was not needed." });
  try {
    const value = deps.verifyCodexIsolation === undefined ? await new CodexIsolationVerifier({ env }).verify(snapshot) : await deps.verifyCodexIsolation(snapshot);
    return Object.freeze({ attempted: true, eligible: true, attestation: value, reason: null });
  } catch (error) {
    const safe = safeError(error);
    return Object.freeze({ attempted: true, eligible: false, attestation: null, reason: `${safe.code}: ${safe.message}` });
  }
}

function runtimeFor(state: OperatorStatePaths, snapshots: readonly ProviderSnapshot[]): { readonly router: CapabilityRouter; readonly runtimes: readonly unknown[] } {
  const entries = new ModelCatalog(state.modelCatalogPath).load();
  if (!entries.some((entry) => entry.configured)) throw new BrainGateInvariantError("MODEL_CATALOG_EMPTY", "No configured models are available. Import/discover then add scored model definitions before dogfood execution.");
  const quota = new GlobalQuotaStore(state.globalDir);
  try {
    const hydrated = hydrateModelRegistry({ entries, providers: snapshots, quota: quota.latest() });
    return Object.freeze({ router: new CapabilityRouter(hydrated.registry), runtimes: hydrated.runtimes });
  } finally { quota.close(); }
}

function resolveWriteRepository(project: RegisteredProject, cwd: string, requested: string | undefined): string {
  if (requested === undefined) {
    if (project.repositories.length !== 1) throw new BrainGateInvariantError("CLI_REPOSITORY_REQUIRED", "Multi-repository projects require explicit --repo for dogfood writes.");
    return project.repositories[0]!;
  }
  let candidate: string;
  try { candidate = realpathSync.native(resolve(cwd, requested)); }
  catch { throw new BrainGateInvariantError("CLI_REPOSITORY_INVALID", "--repo does not resolve to an accessible registered repository."); }
  if (!project.repositories.includes(candidate)) throw new BrainGateInvariantError("CLI_REPOSITORY_INVALID", "--repo is not registered to the selected project.");
  return candidate;
}

function rolesFromPlan(roles: readonly { readonly role: string; readonly model: { readonly providerId: string; readonly modelId: string } }[]): readonly DogfoodRole[] {
  return Object.freeze(roles.map((role) => Object.freeze({ role: role.role as DogfoodRole["role"], providerId: role.model.providerId, modelId: role.model.modelId })));
}

function shadowOutcome(value: string | null): { readonly outcome: DogfoodOutcome; readonly verdict: DogfoodReviewerVerdict; readonly success: boolean } {
  switch (value) {
    case "completed_without_review": return { outcome: "success", verdict: null, success: true };
    case "approved":
    case "approved_after_repair":
    case "approved_by_judge": return { outcome: "success", verdict: "approve", success: true };
    case "repaired_needs_review": return { outcome: "partial", verdict: "request_changes", success: false };
    case "blocked_disagreement": return { outcome: "blocked", verdict: "disagree", success: false };
    case "blocked_changes_required": return { outcome: "blocked", verdict: "request_changes", success: false };
    default: return { outcome: "failed", verdict: null, success: false };
  }
}

function writeOutcome(input: { readonly readyForApproval: boolean; readonly review: { readonly verdict: string } | null; readonly verification: readonly { readonly passed: boolean }[] }): { readonly outcome: DogfoodOutcome; readonly verdict: DogfoodReviewerVerdict } {
  const verdict = input.review === null ? null : (input.review.verdict as Exclude<DogfoodReviewerVerdict, null>);
  if (input.readyForApproval) return { outcome: "success", verdict };
  if (input.verification.some((item) => !item.passed)) return { outcome: "failed", verdict };
  return { outcome: "blocked", verdict };
}

function classificationView(predicted: TaskClassification, effective: TaskClassification, prior: ReturnType<DogfoodStore["derivePrior"]>, applied: boolean) {
  return Object.freeze({ predicted: { complexity: predicted.complexity, risk: predicted.risk, confidence: predicted.confidence, ruleVersion: predicted.ruleVersion }, effective: { complexity: effective.complexity, risk: effective.risk, confidence: effective.confidence, ruleVersion: effective.ruleVersion }, prior, applied });
}

async function runPreflight(args: string[], deps: DogfoodCliDependencies, cwd: string, env: NodeJS.ProcessEnv, json: boolean, stdout: (text: string) => void): Promise<DogfoodCliResult> {
  const state = resolveOperatorState(env);
  const manifest = manifestOption(args);
  noExtraArgs(args);
  const project = projectFromManifest(state, manifest, cwd);
  const repositories = project.repositories.map(inspectGitRepository);
  const snapshots = await discovery(deps);
  const catalog = new ModelCatalog(state.modelCatalogPath).load();
  const configured = catalog.filter((entry) => entry.configured);
  const isolation = await codexIsolationStatus(snapshots, deps, env, configured.some((entry) => entry.providerId === "openai"));
  const providerById = new Map<string, ProviderSnapshot>(snapshots.map((snapshot) => [snapshot.providerId, snapshot]));

  const askCandidates = configured.filter((entry) => {
    const snapshot = providerById.get(entry.providerId);
    return snapshot !== undefined && snapshot.available.value === true && snapshot.authState.value === "authenticated" && snapshot.authMode.value === "subscription" && shadowProviderRoleStatus(snapshot.providerId, "primary").enabled;
  });
  let writeCandidate = false;
  for (const entry of configured) {
    if (entry.providerId !== "anthropic" || !entry.configured || !entry.definition.writeCapable) continue;
    const snapshot = providerById.get("anthropic");
    if (snapshot === undefined) continue;
    try {
      assertClaudeWriteEligible(snapshot, { providerId: snapshot.providerId, modelId: entry.modelId, quotaPool: entry.definition.quotaPool });
      writeCandidate = true;
    } catch { /* reported as unavailable below */ }
  }
  const cleanForWrite = repositories.every((repo) => repo.clean);
  const reviewerCandidates = configured.filter((entry) => {
    const snapshot = providerById.get(entry.providerId);
    if (snapshot === undefined || !shadowProviderRoleStatus(snapshot.providerId, "reviewer").enabled) return false;
    if (snapshot.providerId === "openai") return isolation.eligible;
    return snapshot.authState.value === "authenticated" && snapshot.authMode.value === "subscription";
  });
  const blockers: string[] = [];
  if (configured.length === 0) blockers.push("No scored models are configured in the model catalog.");
  if (askCandidates.length === 0) blockers.push("No authenticated configured model is eligible as a read-only primary.");
  if (!writeCandidate) blockers.push("No authenticated configured Claude model is eligible for M11 restricted writes.");
  if (!cleanForWrite) blockers.push("At least one registered repository is dirty; worktree writes require a clean source checkout.");

  const data = Object.freeze({
    project: { projectId: project.projectId, name: project.name, manifest: resolve(cwd, manifest) },
    repositories,
    catalog: { entries: catalog.length, configured: configured.length, unscored: catalog.length - configured.length },
    providers: snapshots.map((snapshot) => ({ providerId: snapshot.providerId, available: snapshot.available.value, version: snapshot.version.value, authState: snapshot.authState.value, authMode: snapshot.authMode.value })),
    ask: { ready: askCandidates.length > 0, candidates: askCandidates.map((entry) => `${entry.providerId}/${entry.modelId}`) },
    write: { ready: writeCandidate && cleanForWrite, primaryReady: writeCandidate, sourceClean: cleanForWrite, reviewerReady: reviewerCandidates.length > 0, reviewerCandidates: reviewerCandidates.map((entry) => `${entry.providerId}/${entry.modelId}`) },
    codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason },
    blockers,
    providerModelCalls: 0,
  });
  emit(json, data, `Dogfood preflight ${project.projectId}: ask=${data.ask.ready ? "ready" : "blocked"} · write=${data.write.ready ? "ready" : "blocked"} · configured=${configured.length} · model calls=0${blockers.length > 0 ? `\n${blockers.map((item) => `- ${item}`).join("\n")}` : ""}`, stdout);
  return Object.freeze({ exitCode: data.ask.ready ? 0 : 1, data });
}

async function runAsk(args: string[], deps: DogfoodCliDependencies, cwd: string, env: NodeJS.ProcessEnv, json: boolean, stdout: (text: string) => void): Promise<DogfoodCliResult> {
  const action = args.shift();
  if (action !== "plan" && action !== "run") throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "dogfood ask requires plan or run.");
  const manifest = manifestOption(args);
  const task = takeOption(args, "--task", true)!;
  const execute = removeFlag(args, "--execute");
  const optionalReview = removeFlag(args, "--review");
  const oauth = attestations(args);
  noExtraArgs(args);
  if (action === "plan" && execute) throw new BrainGateInvariantError("CLI_EXECUTE_INVALID", "--execute is valid only with dogfood ask run.");

  const state = resolveOperatorState(env);
  const project = projectFromManifest(state, manifest, cwd);
  const snapshots = await discovery(deps);
  const runtime = runtimeFor(state, snapshots);
  const store = new DogfoodStore(project);
  try {
    const predicted = classifyTask({ text: task, mode: "ask" });
    const prior = store.derivePrior("ask");
    const adaptive = applyDogfoodPrior(predicted, prior);
    const effective = adaptive.effective;
    const budget = budgetFor(effective, { writeRequested: false });
    const requiredContextTokens = contextTokens(task);
    const context = Object.freeze({ projectId: project.projectId, scope: "dogfood-project-read-only", access: "read-only" });
    const needsReview = budget.reviewerPolicy === "required" || (budget.reviewerPolicy === "optional" && optionalReview);
    const isolation = await codexIsolationStatus(snapshots, deps, env, needsReview && configuredOpenAi(state));
    const codexIsolation = isolation.attestation ?? undefined;
    const plan = buildShadowTaskPlan({ project, cwd, router: runtime.router, providers: snapshots, attestations: oauth, task, context, classification: effective, budget, requiredContextTokens, optionalReview, ...(codexIsolation === undefined ? {} : { codexIsolation }) });
    const view = classificationView(predicted, effective, prior, adaptive.applied);
    const planData = Object.freeze({ classification: view, budget, roles: plan.roles.map((role) => ({ role: role.role, model: role.model, invocation: role.invocation })), providerCallsOnPlan: 0 });

    if (action === "plan" || !execute) {
      const data = { ...planData, codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason } };
      emit(json, data, `${effective.complexity}/${effective.risk}${adaptive.applied ? " · project prior applied" : ""} · ${plan.roles.map((role) => `${role.role}=${role.model.providerId}/${role.model.modelId}`).join(" · ")}\nZero provider model calls executed.`, stdout);
      return Object.freeze({ exitCode: 0, data });
    }

    const ledger = new TaskLedger(project);
    try {
      const runner = new ShadowDogfoodRunner({ project, ledger, router: runtime.router, snapshots, attestations: oauth, ...(codexIsolation === undefined ? {} : { codexIsolation }), ...(deps.executor === undefined ? {} : { executor: deps.executor }) });
      const result = await runner.run({ title: `Dogfood ask ${effective.complexity}`, task, cwd, classification: effective, budget, requiredContextTokens, context, contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: requiredContextTokens, truncatedItems: 0, sourceLabels: ["dogfood-minimal-context"] }, optionalReview, dryRun: false });
      const mapped = shadowOutcome(result.workflow?.outcome ?? null);
      const observation = store.recordRun({ receipt: result.taskReceipt, mode: "ask", predicted, effective, roles: rolesFromPlan(plan.roles), outcome: mapped.outcome, reviewerVerdict: mapped.verdict, prior });
      const data = Object.freeze({ plan: planData, taskId: result.taskId, observationSequence: observation.sequence, outcome: result.workflow?.outcome ?? null, answer: result.workflow?.finalOutput ?? null, usage: result.taskReceipt.usage });
      emit(json, data, `${result.workflow?.finalOutput ?? "No answer returned."}\n\nTask ${result.taskId} · observed=${observation.sequence} · outcome=${result.workflow?.outcome ?? "unknown"}`, stdout);
      return Object.freeze({ exitCode: mapped.success ? 0 : 1, data });
    } finally { ledger.close(); }
  } finally { store.close(); }
}

async function runWrite(args: string[], deps: DogfoodCliDependencies, cwd: string, env: NodeJS.ProcessEnv, json: boolean, stdout: (text: string) => void): Promise<DogfoodCliResult> {
  const action = args.shift();
  if (action !== "plan" && action !== "run") throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "dogfood write requires plan or run.");
  const manifest = manifestOption(args);
  const task = takeOption(args, "--task", true)!;
  const requestedRepo = takeOption(args, "--repo");
  const baseRef = takeOption(args, "--base") ?? "HEAD";
  const execute = removeFlag(args, "--execute");
  const review = !removeFlag(args, "--no-review");
  const oauth = attestations(args);
  noExtraArgs(args);
  if (action === "plan" && execute) throw new BrainGateInvariantError("CLI_EXECUTE_INVALID", "--execute is valid only with dogfood write run.");

  const state = resolveOperatorState(env);
  const project = projectFromManifest(state, manifest, cwd);
  const repositoryPath = resolveWriteRepository(project, cwd, requestedRepo);
  const snapshots = await discovery(deps);
  const runtime = runtimeFor(state, snapshots);
  const store = new DogfoodStore(project);
  try {
    const predicted = classifyTask({ text: task, mode: "write" });
    const prior = store.derivePrior("write");
    const adaptive = applyDogfoodPrior(predicted, prior);
    const effective = adaptive.effective;
    const budget = budgetFor(effective, { writeRequested: true });
    const requiredContextTokens = contextTokens(task);
    const isolation = await codexIsolationStatus(snapshots, deps, env, review && configuredOpenAi(state));
    const codexIsolation = isolation.attestation ?? undefined;
    const plan = buildWriteTaskPlan({ router: runtime.router, providers: snapshots, attestations: oauth, ...(codexIsolation === undefined ? {} : { codexIsolation }), classification: effective, budget, requiredContextTokens, repositoryPath, baseRef, review });
    const view = classificationView(predicted, effective, prior, adaptive.applied);
    const planData = Object.freeze({ classification: view, budget, repositoryPath, baseRef, roles: plan.roles.map((role) => ({ role: role.role, model: role.model, workspace: role.workspace })), providerCallsOnPlan: 0, createsWorktree: false, mergeAvailable: false });

    if (action === "plan" || !execute) {
      const data = { ...planData, codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason }, approvalRequired: true };
      emit(json, data, `${effective.complexity}/${effective.risk}${adaptive.applied ? " · project prior applied" : ""} · ${plan.roles.map((role) => `${role.role}=${role.model.providerId}/${role.model.modelId}`).join(" · ")}\nZero provider model calls. Zero worktrees. Merge unavailable.`, stdout);
      return Object.freeze({ exitCode: 0, data });
    }

    const ledger = new TaskLedger(project);
    try {
      const runner = new WriteDogfoodRunner({ project, ledger, router: runtime.router, providers: snapshots, attestations: oauth, ...(codexIsolation === undefined ? {} : { codexIsolation }), ...(deps.writeExecutor === undefined ? {} : { writer: deps.writeExecutor }), ...(deps.executor === undefined ? {} : { reviewExecutor: deps.executor }) });
      const result = await runner.run({ task, repositoryPath, baseRef, classification: effective, budget, requiredContextTokens, context: Object.freeze({ projectId: project.projectId, scope: "dogfood-task-worktree", access: "small-write", merge: "human-only" }), review, dryRun: false, env });
      if (result.taskReceipt === null || result.taskId === null) throw new BrainGateInvariantError("DOGFOOD_WRITE_RECEIPT_MISSING", "Executed dogfood write did not produce a task receipt.");
      const mapped = writeOutcome(result);
      const observation = store.recordRun({ receipt: result.taskReceipt, mode: "write", predicted, effective, roles: rolesFromPlan(plan.roles), outcome: mapped.outcome, reviewerVerdict: mapped.verdict, prior });
      const data = Object.freeze({ plan: planData, taskId: result.taskId, observationSequence: observation.sequence, worktree: result.worktree, changedFiles: result.changedFiles, diff: result.diff, verification: result.verification, review: result.review, readyForApproval: result.readyForApproval, approvalRequired: true, mergePerformed: false, usage: result.taskReceipt.usage });
      emit(json, data, `Task ${result.taskId} · observed=${observation.sequence} · branch=${result.worktree?.branch ?? "unknown"}\nChanged: ${result.changedFiles.join(", ")}\nReady for human approval: ${result.readyForApproval ? "yes" : "no"}. No merge performed.`, stdout);
      return Object.freeze({ exitCode: result.readyForApproval ? 0 : 1, data });
    } finally { ledger.close(); }
  } finally { store.close(); }
}

export async function runDogfoodCli(argv: readonly string[], deps: DogfoodCliDependencies = {}): Promise<DogfoodCliResult> {
  const args = [...argv];
  const json = removeFlag(args, "--json");
  const cwd = realpathSync.native(resolve(deps.cwd ?? process.cwd()));
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  let data: unknown = null;
  try {
    const command = args.shift();
    if (command === "init") {
      const projectId = takeOption(args, "--project-id", true)!;
      const name = takeOption(args, "--name", true)!;
      noExtraArgs(args);
      data = initializeDogfoodProject({ cwd, projectId, name });
      emit(json, data, `${(data as { created: boolean }).created ? "Created" : "Using"} local BrainGate project manifest at ${(data as { manifestPath: string }).manifestPath}`, stdout);
      return Object.freeze({ exitCode: 0, data });
    }
    if (command !== "dogfood") throw new BrainGateInvariantError("CLI_COMMAND_INVALID", "M12 dispatcher supports init or dogfood.");
    const subcommand = args.shift();
    if (subcommand === undefined || subcommand === "help") {
      data = { commands: ["preflight", "ask", "write", "feedback", "report", "export"] };
      emit(json, data, "BrainGate dogfood commands: preflight, ask, write, feedback, report, export", stdout);
      return Object.freeze({ exitCode: 0, data });
    }
    if (subcommand === "preflight") return await runPreflight(args, deps, cwd, env, json, stdout);
    if (subcommand === "ask") return await runAsk(args, deps, cwd, env, json, stdout);
    if (subcommand === "write") return await runWrite(args, deps, cwd, env, json, stdout);

    const state = resolveOperatorState(env);
    const manifest = manifestOption(args);
    const project = projectFromManifest(state, manifest, cwd);
    const store = new DogfoodStore(project);
    try {
      if (subcommand === "feedback") {
        const taskId = takeOption(args, "--task-id", true)!;
        const actualComplexity = takeOption(args, "--actual-complexity", true)!;
        const actualRisk = takeOption(args, "--actual-risk");
        const outcome = takeOption(args, "--outcome", true)!;
        const regression = removeFlag(args, "--regression");
        noExtraArgs(args);
        data = store.recordFeedback({ taskId, actualComplexity, ...(actualRisk === undefined ? {} : { actualRisk }), outcome, regression });
        emit(json, data, `Recorded feedback for ${taskId}. Adaptive history now has ${store.latestFeedback().length} labeled task(s).`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      if (subcommand === "report") {
        noExtraArgs(args);
        data = store.report();
        const report = data as ReturnType<DogfoodStore["report"]>;
        emit(json, data, `Dogfood ${project.projectId}: runs=${report.runs} · feedback=${report.feedback} · regressions=${report.regressions} · underpredictions=${report.complexityUnderpredictions}\nask prior=${report.priors.ask.active ? `${report.priors.ask.complexityFloor ?? "-"}/${report.priors.ask.riskFloor ?? "-"}` : "inactive"} · write prior=${report.priors.write.active ? `${report.priors.write.complexityFloor ?? "-"}/${report.priors.write.riskFloor ?? "-"}` : "inactive"}`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      if (subcommand === "export") {
        const output = takeOption(args, "--output") ?? ".brain/dogfood-regressions.jsonl";
        noExtraArgs(args);
        const path = resolve(cwd, output);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const text = store.regressionJsonl();
        writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
        data = { projectId: project.projectId, path, records: text.length === 0 ? 0 : text.trimEnd().split("\n").length };
        emit(json, data, `Exported ${(data as { records: number }).records} sanitized regression record(s) to ${path}`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "dogfood requires preflight, ask, write, feedback, report, or export.");
    } finally { store.close(); }
  } catch (error) {
    const safe = safeError(error);
    data = { error: safe };
    stderr(json ? `${JSON.stringify(data, null, 2)}\n` : `BrainGate ${safe.code}: ${safe.message}\n`);
    return Object.freeze({ exitCode: 1, data });
  }
}
