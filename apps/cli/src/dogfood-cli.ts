import { findManifest } from "./manifest-path.js";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
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
  repositoryReadiness,
  type DogfoodOutcome,
  type DogfoodReviewerVerdict,
  type DogfoodRole,
} from "@braingate/dogfood";
import { GlobalQuotaStore } from "@braingate/observability";
import { ModelCatalog, buildShadowTaskPlan, hydrateModelRegistry, resolveOperatorState, type OperatorStatePaths } from "@braingate/operator";
import { ModelListCache, ProviderDiscovery, type ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter } from "@braingate/router";
import {
  CodexIsolationVerifier,
  ShadowDogfoodRunner,
  shadowProviderRoleStatus,
  type CodexIsolationAttestation,
  type GrokIsolationAttestation,
  type ShadowProcessExecutor,
  type SubscriptionAttestation,
} from "@braingate/shadow";
import { acceptedSubscriptions, codexIsolationStatusFor, configuredProvider, grokIsolationStatus, isolationCacheFor, loadAcceptances, type IsolationStatus } from "./provider-proof.js";
import { taskTitleFor } from "@braingate/security";
import { collectTaskMemory } from "./task-memory.js";
import { WriteDogfoodRunner, assertClaudeWriteEligible, buildWriteTaskPlan, type WriteProviderExecutor } from "@braingate/write";

export interface DogfoodCliDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly discoverAll?: () => Promise<readonly ProviderSnapshot[]>;
  readonly verifyCodexIsolation?: (snapshot: ProviderSnapshot) => Promise<CodexIsolationAttestation>;
  readonly verifyGrokIsolation?: (snapshot: ProviderSnapshot) => Promise<GrokIsolationAttestation>;
  readonly executor?: ShadowProcessExecutor;
  readonly writeExecutor?: WriteProviderExecutor;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /**
   * Asks the operator a single question and resolves to their answer, or to null when there
   * is nobody to ask. Injected so tests never depend on a terminal, and so a non-interactive
   * run fails with a usable message instead of waiting on stdin forever.
   */
  readonly ask?: (question: string) => Promise<string | null>;
  /**
   * Turns already exchanged in an interactive session, so a follow-up resolves against them.
   * Supplied only by the session; the flag interface never sets it, and nothing here is
   * persisted or promoted to memory.
   */
  readonly sessionTurns?: (contextTokenBudget: number) => readonly { readonly request: string; readonly answer: string }[];
  /** Set by the interactive session, which has already introduced itself and shows its own prompt. */
  readonly quiet?: boolean;
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
  // Walks upward, because init writes the manifest at the repository root and this may be run
  // from any directory beneath it.
  const path = findManifest(cwd, manifest);
  // A missing manifest is the ordinary "you are not in a registered project" case, especially
  // now that `braingate` is on PATH and gets run from anywhere. Without this it reached the
  // catch-all and printed CLI_UNEXPECTED with details suppressed, which says nothing about
  // what to do next. The message names the relative path only, never the resolved one.
  if (!existsSync(path)) {
    throw new BrainGateInvariantError(
      "CLI_PROJECT_NOT_FOUND",
      `No BrainGate project found here (looked for ${manifest} in the current directory). Run \`braingate init --project-id <id> --name <name>\` inside the repository, or pass --project <manifest>.`,
    );
  }
  const registry = new ProjectRegistry(state.home);
  return registry.loadFile(path);
}

/**
 * A question function backed by the real terminal, or undefined when this run has no terminal
 * to ask (a pipe, CI, an editor task). Returning undefined rather than reading stdin anyway is
 * what keeps a scripted `braingate init` from hanging forever waiting for an answer.
 */
function terminalAsk(): ((question: string) => Promise<string | null>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return async (question: string): Promise<string | null> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(question); }
    catch { return null; }
    finally { rl.close(); }
  };
}

/**
 * Turns a directory name into a candidate project id: lowercase, non-alphanumerics collapsed
 * to single hyphens, trimmed to the registry's 64-character limit. Returns null when nothing
 * usable survives, in which case the operator is asked outright rather than given a guess.
 */
export function suggestedProjectId(directoryName: string): string | null {
  const slug = directoryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length === 0 ? null : slug;
}

/**
 * Resolves the project identity for `init`.
 *
 * The identity is the isolation boundary — memory, worktrees and telemetry are all scoped to
 * it — so BrainGate proposes one and has it confirmed rather than deciding silently. Explicit
 * flags skip the question entirely, which keeps scripted use unchanged, and a run with nobody
 * to ask fails with the flags to pass instead of blocking on stdin.
 */
async function resolveProjectIdentity(input: {
  readonly cwd: string;
  readonly projectId: string | null;
  readonly name: string | null;
  readonly ask: ((question: string) => Promise<string | null>) | undefined;
  readonly stdout: (text: string) => void;
  readonly quiet?: boolean;
}): Promise<{ readonly projectId: string; readonly name: string }> {
  if (input.projectId !== null && input.name !== null) return { projectId: input.projectId, name: input.name };

  const directory = basename(input.cwd);
  const suggestion = suggestedProjectId(directory);
  const missingFlags = new BrainGateInvariantError(
    "CLI_OPTION_REQUIRED",
    `Cannot ask for the project identity without a terminal. Pass --project-id <id> and --name <name>${suggestion === null ? "" : ` (suggested id: ${suggestion})`}.`,
  );
  if (input.ask === undefined) throw missingFlags;

  // A session has already introduced itself and explained the boundary, so it passes quiet:true
  // rather than have the operator read the same two sentences twice.
  if (input.quiet !== true) {
    input.stdout(`Registering the repository in ${directory} with BrainGate.\n`);
    input.stdout("The project id is the isolation boundary: memory, worktrees and telemetry are scoped to it.\n\n");
  }

  let projectId = input.projectId;
  if (projectId === null) {
    const answer = await input.ask(suggestion === null ? "Project id: " : `Project id [${suggestion}]: `);
    if (answer === null) throw missingFlags;
    const chosen = answer.trim().length === 0 ? suggestion : answer.trim();
    if (chosen === null) throw new BrainGateInvariantError("CLI_OPTION_REQUIRED", "A project id is required.");
    projectId = chosen;
  }

  let name = input.name;
  if (name === null) {
    const answer = await input.ask(`Display name [${directory}]: `);
    if (answer === null) throw missingFlags;
    name = answer.trim().length === 0 ? directory : answer.trim();
  }
  return { projectId, name };
}

function manifestOption(args: string[]): string { return takeOption(args, "--project") ?? ".brain/project.json"; }
function contextTokens(task: string): number { return Math.max(128, conservativeTokenEstimate(task) + 64); }

function attestations(copilotOauth: boolean, state: OperatorStatePaths): readonly SubscriptionAttestation[] {
  // An acceptance already carries the operator's statement about how that provider is billed,
  // so it does not need a second flag on every command.
  const accepted = acceptedSubscriptions(state);
  if (!copilotOauth) return Object.freeze(accepted);
  const observed = new Date();
  return Object.freeze([...accepted, Object.freeze({
    providerId: "github-copilot",
    mode: "subscription",
    source: "user-confirmed-oauth",
    observedAt: observed.toISOString(),
    expiresAt: new Date(observed.getTime() + 60 * 60 * 1000).toISOString(),
  })]);
}

/** Discovery for one command; see the note on the same helper in cli.ts. */
async function discovery(deps: DogfoodCliDependencies, state: OperatorStatePaths): Promise<readonly ProviderSnapshot[]> {
  if (deps.discoverAll !== undefined) return await deps.discoverAll();
  const modelCache = new ModelListCache({ path: resolve(state.globalDir, "model-lists.json") });
  return await new ProviderDiscovery(undefined, { modelCache }).discoverAll();
}

function configuredOpenAi(state: OperatorStatePaths): boolean {
  return new ModelCatalog(state.modelCatalogPath).load().some((entry) => entry.configured && entry.providerId === "openai");
}

async function codexIsolationStatus(
  snapshots: readonly ProviderSnapshot[],
  deps: DogfoodCliDependencies,
  env: NodeJS.ProcessEnv,
  shouldAttempt: boolean,
  state: OperatorStatePaths,
): Promise<IsolationStatus<CodexIsolationAttestation>> {
  return await codexIsolationStatusFor({
    snapshots,
    env,
    shouldAttempt,
    cache: isolationCacheFor(state),
    ...(deps.verifyCodexIsolation === undefined ? {} : { verify: deps.verifyCodexIsolation }),
  });
}

/** Grok's sandbox, re-proved for this command; see apps/cli/src/provider-proof.ts. */
async function grokProof(
  state: OperatorStatePaths,
  snapshots: readonly ProviderSnapshot[],
  deps: DogfoodCliDependencies,
  env: NodeJS.ProcessEnv,
  project?: RegisteredProject,
): Promise<Awaited<ReturnType<typeof grokIsolationStatus>>> {
  return await grokIsolationStatus({
    snapshots,
    env,
    shouldAttempt: configuredProvider(new ModelCatalog(state.modelCatalogPath).load(), "xai"),
    cache: isolationCacheFor(state),
    ...(project === undefined ? {} : { project }),
    ...(deps.verifyGrokIsolation === undefined ? {} : { verify: deps.verifyGrokIsolation }),
  });
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
  const snapshots = await discovery(deps, state);
  const catalog = new ModelCatalog(state.modelCatalogPath).load();
  const configured = catalog.filter((entry) => entry.configured);
  const isolation = await codexIsolationStatus(snapshots, deps, env, configured.some((entry) => entry.providerId === "openai"), state);
  const grok = await grokProof(state, snapshots, deps, env, project);
  const acceptances = loadAcceptances(state);
  const roleStatus = (providerId: ProviderSnapshot["providerId"], role: "primary" | "reviewer") => {
    const acceptance = acceptances.find((item) => item.providerId === providerId);
    return shadowProviderRoleStatus(providerId, role, acceptance === undefined ? {} : { acceptance });
  };
  const providerById = new Map<string, ProviderSnapshot>(snapshots.map((snapshot) => [snapshot.providerId, snapshot]));

  const askCandidates = configured.filter((entry) => {
    const snapshot = providerById.get(entry.providerId);
    return snapshot !== undefined && snapshot.available.value === true && snapshot.authState.value === "authenticated" && snapshot.authMode.value === "subscription" && roleStatus(snapshot.providerId, "primary").enabled;
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
  // A repository created a moment ago has a branch and no commit. Worktree writes branch from
  // a commit, so they cannot start yet — and saying that plainly beats letting the write path
  // fail later on `HEAD`.
  const uncommitted = repositories.filter((repo) => repo.head === null);
  const reviewerCandidates = configured.filter((entry) => {
    const snapshot = providerById.get(entry.providerId);
    if (snapshot === undefined || !roleStatus(snapshot.providerId, "reviewer").enabled) return false;
    if (snapshot.providerId === "openai") return isolation.eligible;
    if (snapshot.providerId === "xai") return grok.eligible;
    return snapshot.authState.value === "authenticated" && snapshot.authMode.value === "subscription";
  });
  const blockers: string[] = [];
  if (configured.length === 0) blockers.push("No scored models are configured in the model catalog.");
  if (askCandidates.length === 0) blockers.push("No authenticated configured model is eligible as a read-only primary.");
  if (!writeCandidate) blockers.push("No authenticated configured Claude model is eligible for M11 restricted writes.");
  if (!cleanForWrite) blockers.push("At least one registered repository is dirty; worktree writes require a clean source checkout.");
  if (uncommitted.length > 0) blockers.push("No commit yet in this repository; make a first commit before asking for a change, since worktree writes branch from one. Questions work now.");

  const data = Object.freeze({
    project: { projectId: project.projectId, name: project.name, manifest: resolve(cwd, manifest) },
    repositories,
    catalog: { entries: catalog.length, configured: configured.length, unscored: catalog.length - configured.length },
    providers: snapshots.map((snapshot) => ({ providerId: snapshot.providerId, available: snapshot.available.value, version: snapshot.version.value, authState: snapshot.authState.value, authMode: snapshot.authMode.value })),
    ask: { ready: askCandidates.length > 0, candidates: askCandidates.map((entry) => `${entry.providerId}/${entry.modelId}`) },
    write: { ready: writeCandidate && cleanForWrite && uncommitted.length === 0, primaryReady: writeCandidate, sourceClean: cleanForWrite, reviewerReady: reviewerCandidates.length > 0, reviewerCandidates: reviewerCandidates.map((entry) => `${entry.providerId}/${entry.modelId}`) },
    codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason },
    grokIsolation: { attempted: grok.attempted, eligible: grok.eligible, reason: grok.reason },
    acceptedProviders: acceptances.map((item) => item.providerId),
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
  const copilotOauth = removeFlag(args, "--attest-copilot-oauth");
  noExtraArgs(args);
  if (action === "plan" && execute) throw new BrainGateInvariantError("CLI_EXECUTE_INVALID", "--execute is valid only with dogfood ask run.");

  const state = resolveOperatorState(env);
  const oauth = attestations(copilotOauth, state);
  const project = projectFromManifest(state, manifest, cwd);
  const snapshots = await discovery(deps, state);
  const runtime = runtimeFor(state, snapshots);
  const store = new DogfoodStore(project);
  try {
    const predicted = classifyTask({ text: task, mode: "ask" });
    const prior = store.derivePrior("ask");
    const adaptive = applyDogfoodPrior(predicted, prior);
    const effective = adaptive.effective;
    const budget = budgetFor(effective, { writeRequested: false });
    const requiredContextTokens = contextTokens(task);
    const memory = collectTaskMemory(project, task, budget.maxContextTokens);
    const context = Object.freeze({
      projectId: project.projectId,
      scope: "dogfood-project-read-only",
      access: "read-only",
      // Canonical memory only. Proposals become canonical through `memory promote`, which
      // requires explicit evidence; surfacing them here would route around that gate.
      memory: memory.records,
      // Ephemeral: this session's earlier turns, never written to disk and never promoted.
      session: deps.sessionTurns?.(budget.maxContextTokens) ?? [],
    });
    const needsReview = budget.reviewerPolicy === "required" || (budget.reviewerPolicy === "optional" && optionalReview);
    const isolation = await codexIsolationStatus(snapshots, deps, env, needsReview && configuredOpenAi(state), state);
    const codexIsolation = isolation.attestation ?? undefined;
    const grok = await grokProof(state, snapshots, deps, env, project);
    const grokIsolation = grok.attestation ?? undefined;
    const acceptances = loadAcceptances(state);
    const plan = buildShadowTaskPlan({ project, cwd, router: runtime.router, providers: snapshots, attestations: oauth, task, context, classification: effective, budget, requiredContextTokens, optionalReview, acceptances, ...(codexIsolation === undefined ? {} : { codexIsolation }), ...(grokIsolation === undefined ? {} : { grokIsolation }) });
    const view = classificationView(predicted, effective, prior, adaptive.applied);
    const planData = Object.freeze({ classification: view, budget, roles: plan.roles.map((role) => ({ role: role.role, model: role.model, invocation: role.invocation })), providerCallsOnPlan: 0 });

    if (action === "plan" || !execute) {
      const data = { ...planData, codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason } };
      emit(json, data, `${effective.complexity}/${effective.risk}${adaptive.applied ? " · project prior applied" : ""} · ${plan.roles.map((role) => `${role.role}=${role.model.providerId}/${role.model.modelId}`).join(" · ")}\nZero provider model calls executed.`, stdout);
      return Object.freeze({ exitCode: 0, data });
    }

    const ledger = new TaskLedger(project);
    try {
      const runner = new ShadowDogfoodRunner({ project, ledger, router: runtime.router, snapshots, attestations: oauth, acceptances, ...(codexIsolation === undefined ? {} : { codexIsolation }), ...(grokIsolation === undefined ? {} : { grokIsolation }), ...(deps.executor === undefined ? {} : { executor: deps.executor }) });
      const result = await runner.run({ title: taskTitleFor(task), task, cwd, classification: effective, budget, requiredContextTokens, context, contextSummary: { memoryRecords: memory.recordCount, explicitCandidates: 0, includedItems: 1 + memory.recordCount, estimatedTokens: requiredContextTokens + memory.estimatedTokens, truncatedItems: memory.truncated, sourceLabels: memory.recordCount === 0 ? ["dogfood-minimal-context"] : ["dogfood-minimal-context", "project-canonical-memory"] }, optionalReview, dryRun: false });
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
  const copilotOauth = removeFlag(args, "--attest-copilot-oauth");
  noExtraArgs(args);
  if (action === "plan" && execute) throw new BrainGateInvariantError("CLI_EXECUTE_INVALID", "--execute is valid only with dogfood write run.");

  const state = resolveOperatorState(env);
  const oauth = attestations(copilotOauth, state);
  const project = projectFromManifest(state, manifest, cwd);
  const repositoryPath = resolveWriteRepository(project, cwd, requestedRepo);
  const snapshots = await discovery(deps, state);
  const runtime = runtimeFor(state, snapshots);
  const store = new DogfoodStore(project);
  try {
    const predicted = classifyTask({ text: task, mode: "write" });
    const prior = store.derivePrior("write");
    const adaptive = applyDogfoodPrior(predicted, prior);
    const effective = adaptive.effective;
    const budget = budgetFor(effective, { writeRequested: true });
    const requiredContextTokens = contextTokens(task);
    const isolation = await codexIsolationStatus(snapshots, deps, env, review && configuredOpenAi(state), state);
    const codexIsolation = isolation.attestation ?? undefined;
    const grok = await grokProof(state, snapshots, deps, env, project);
    const grokIsolation = grok.attestation ?? undefined;
    const acceptances = loadAcceptances(state);
    const plan = buildWriteTaskPlan({ router: runtime.router, providers: snapshots, attestations: oauth, acceptances, ...(codexIsolation === undefined ? {} : { codexIsolation }), ...(grokIsolation === undefined ? {} : { grokIsolation }), classification: effective, budget, requiredContextTokens, repositoryPath, baseRef, review });
    const view = classificationView(predicted, effective, prior, adaptive.applied);
    const planData = Object.freeze({ classification: view, budget, repositoryPath, baseRef, roles: plan.roles.map((role) => ({ role: role.role, model: role.model, workspace: role.workspace })), providerCallsOnPlan: 0, createsWorktree: false, mergeAvailable: false });

    if (action === "plan" || !execute) {
      const data = { ...planData, codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason }, approvalRequired: true };
      emit(json, data, `${effective.complexity}/${effective.risk}${adaptive.applied ? " · project prior applied" : ""} · ${plan.roles.map((role) => `${role.role}=${role.model.providerId}/${role.model.modelId}`).join(" · ")}\nZero provider model calls. Zero worktrees. Merge unavailable.`, stdout);
      return Object.freeze({ exitCode: 0, data });
    }

    const ledger = new TaskLedger(project);
    try {
      const runner = new WriteDogfoodRunner({ project, ledger, router: runtime.router, providers: snapshots, attestations: oauth, acceptances, ...(codexIsolation === undefined ? {} : { codexIsolation }), ...(grokIsolation === undefined ? {} : { grokIsolation }), ...(deps.writeExecutor === undefined ? {} : { writer: deps.writeExecutor }), ...(deps.executor === undefined ? {} : { reviewExecutor: deps.executor }) });
      const result = await runner.run({ task, repositoryPath, baseRef, classification: effective, budget, requiredContextTokens, context: Object.freeze({ projectId: project.projectId, scope: "dogfood-task-worktree", access: "small-write", merge: "human-only", memory: collectTaskMemory(project, task, budget.maxContextTokens).records, session: deps.sessionTurns?.(budget.maxContextTokens) ?? [] }), review, dryRun: false, env });
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
      const flagProjectId = takeOption(args, "--project-id") ?? null;
      const flagName = takeOption(args, "--name") ?? null;
      const gitInitFlag = removeFlag(args, "--git-init");
      noExtraArgs(args);
      // Asked first, because it decides whether the identity questions are worth asking at all.
      // A new directory is where people start, and finding out it cannot be registered only
      // after answering two prompts — with git's own error, not BrainGate's — is the ordering
      // that made this feel like a wall rather than a step.
      const ask = deps.ask ?? terminalAsk();
      let createRepository = gitInitFlag;
      if (!createRepository && repositoryReadiness(cwd).repositoryPath === null) {
        if (json) throw new BrainGateInvariantError("PROJECT_NOT_A_REPOSITORY", "There is no Git repository here. Re-run with --git-init to create one, or run `git init` yourself.");
        stdout([
          "",
          `  ${cwd} is not a Git repository yet.`,
          "  BrainGate makes every change in a task worktree and fingerprints your checkout",
          "  before and after each run, so it needs a repository to work in.",
          "",
        ].join("\n"));
        // Without a terminal there is nobody to ask, and creating a repository unasked would
        // be BrainGate writing to their disk on a guess.
        const answer = ask === undefined ? null : await ask("  Create one here with `git init`? [Y/n] ");
        if (answer === null || /^n(o)?$/i.test(answer.trim())) {
          throw new BrainGateInvariantError("PROJECT_NOT_A_REPOSITORY", "Nothing was created. Run `git init` here when you are ready, then `braingate init` again — or `braingate init --git-init` to do both.");
        }
        createRepository = true;
      }
      const identity = await resolveProjectIdentity({ cwd, projectId: flagProjectId, name: flagName, ask, stdout, quiet: deps.quiet === true });
      data = initializeDogfoodProject({ cwd, projectId: identity.projectId, name: identity.name, createRepository });
      const created = (data as { created: boolean }).created;
      const manifestPath = (data as { manifestPath: string }).manifestPath;
      emit(
        json,
        data,
        deps.quiet === true
          ? `${created ? "Registered" : "Using"} ${identity.projectId}.`
          : [
            `${created ? "Created" : "Using"} local BrainGate project manifest at ${manifestPath}`,
            "",
            "Next:",
            "  braingate dogfood preflight                      check readiness, zero model calls",
            '  braingate dogfood ask plan --task "<question>"   see the routing before spending anything',
            '  braingate dogfood ask run  --task "<question>" --execute',
          ].join("\n"),
        stdout,
      );
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
