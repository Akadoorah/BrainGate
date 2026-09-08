import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { conservativeTokenEstimate } from "@braingate/context";
import {
  BrainGateInvariantError,
  ProjectRegistry,
  TaskLedger,
  budgetFor,
  classifyTask,
  type RegisteredProject,
} from "@braingate/core";
import { startDashboardServer } from "@braingate/dashboard";
import { buildDashboardSnapshot, GlobalQuotaStore, type DashboardSnapshot } from "@braingate/observability";
import {
  ModelCatalog,
  buildShadowTaskPlan,
  hydrateModelRegistry,
  resolveOperatorState,
  type OperatorStatePaths,
} from "@braingate/operator";
import { ProviderDiscovery, type ProviderSnapshot } from "@braingate/providers";
import { CapabilityRouter, type ModelDefinition } from "@braingate/router";
import {
  CodexIsolationVerifier,
  ShadowDogfoodRunner,
  shadowProviderRoleStatus,
  shadowProviderStatus,
  type CodexIsolationAttestation,
  type ShadowProcessExecutor,
  type SubscriptionAttestation,
} from "@braingate/shadow";
import { WriteDogfoodRunner, buildWriteTaskPlan, type WriteProviderExecutor } from "@braingate/write";

export interface CliDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly discoverAll?: () => Promise<readonly ProviderSnapshot[]>;
  readonly verifyCodexIsolation?: (snapshot: ProviderSnapshot) => Promise<CodexIsolationAttestation>;
  readonly executor?: ShadowProcessExecutor;
  readonly writeExecutor?: WriteProviderExecutor;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly startDashboard?: (
    snapshotProvider: () => DashboardSnapshot,
    options: { readonly host?: string; readonly port?: number },
  ) => Promise<{ readonly url: string }>;
}

export interface CliResult {
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
  for (let index = args.length - 1; index >= 0; index--) {
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

function emit(
  json: boolean,
  data: unknown,
  human: string,
  stdout: (text: string) => void,
): void {
  stdout(json ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);
}

function safeError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof BrainGateInvariantError) return Object.freeze({ code: error.code, message: error.message });
  if (error instanceof RangeError) return Object.freeze({ code: "CLI_RANGE_ERROR", message: error.message });
  return Object.freeze({ code: "CLI_UNEXPECTED", message: "Unexpected BrainGate operator failure. Raw error details were suppressed." });
}

function projectFromManifest(state: OperatorStatePaths, manifest: string, cwd: string): RegisteredProject {
  const path = resolve(cwd, manifest);
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

function taskContext(project: RegisteredProject): Readonly<Record<string, unknown>> {
  return Object.freeze({ projectId: project.projectId, scope: "registered-project-cwd", access: "read-only" });
}

function writeTaskContext(project: RegisteredProject): Readonly<Record<string, unknown>> {
  return Object.freeze({ projectId: project.projectId, scope: "task-worktree", access: "small-write", merge: "human-only" });
}

function contextTokens(task: string): number {
  return Math.max(128, conservativeTokenEstimate(task) + 64);
}

function attestation(args: string[]): readonly SubscriptionAttestation[] {
  if (!removeFlag(args, "--attest-copilot-oauth")) return Object.freeze([]);
  const observed = new Date();
  const expires = new Date(observed.getTime() + 60 * 60 * 1000);
  return Object.freeze([Object.freeze({
    providerId: "github-copilot",
    mode: "subscription",
    source: "user-confirmed-oauth",
    observedAt: observed.toISOString(),
    expiresAt: expires.toISOString(),
  })]);
}

function normalizedDiscovery(snapshots: readonly ProviderSnapshot[]): readonly unknown[] {
  return Object.freeze(snapshots.map((snapshot) => Object.freeze({
    providerId: snapshot.providerId,
    displayName: snapshot.displayName,
    binary: snapshot.binary,
    available: snapshot.available,
    version: snapshot.version,
    authState: snapshot.authState,
    authMode: snapshot.authMode,
    models: snapshot.models,
    capabilities: snapshot.capabilities,
    usage: snapshot.usage,
    removedBillingOverrides: snapshot.removedBillingOverrides,
    warnings: snapshot.warnings,
  })));
}

function serializedPlan(plan: ReturnType<typeof buildShadowTaskPlan>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    classification: plan.classification,
    budget: plan.budget,
    requiredContextTokens: plan.requiredContextTokens,
    cwd: plan.cwd,
    roles: Object.freeze(plan.roles.map((role) => Object.freeze({ role: role.role, model: role.model, invocation: role.invocation }))),
  });
}

function serializedWritePlan(plan: ReturnType<typeof buildWriteTaskPlan>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    classification: plan.classification,
    budget: plan.budget,
    requiredContextTokens: plan.requiredContextTokens,
    repositoryPath: plan.repositoryPath,
    baseRef: plan.baseRef,
    roles: Object.freeze(plan.roles.map((role) => Object.freeze({ role: role.role, model: role.model, workspace: role.workspace }))),
    providerCallsOnPlan: plan.providerCallsOnPlan,
    createsWorktree: plan.createsWorktree,
    mergeAvailable: plan.mergeAvailable,
  });
}

function resolveWriteRepository(project: RegisteredProject, cwd: string, requested: string | undefined): string {
  if (requested === undefined) {
    if (project.repositories.length !== 1) throw new BrainGateInvariantError("CLI_REPOSITORY_REQUIRED", "Multi-repository projects require an explicit --repo path for write tasks.");
    return project.repositories[0]!;
  }
  let candidate: string;
  try { candidate = realpathSync.native(resolve(cwd, requested)); }
  catch { throw new BrainGateInvariantError("CLI_REPOSITORY_INVALID", "--repo does not resolve to an accessible registered repository."); }
  if (!project.repositories.includes(candidate)) throw new BrainGateInvariantError("CLI_REPOSITORY_INVALID", "--repo is not registered to the selected project.");
  return candidate;
}

async function discovery(deps: CliDependencies): Promise<readonly ProviderSnapshot[]> {
  return deps.discoverAll === undefined ? await new ProviderDiscovery().discoverAll() : await deps.discoverAll();
}

async function codexIsolationStatus(
  snapshots: readonly ProviderSnapshot[],
  deps: CliDependencies,
  env: NodeJS.ProcessEnv,
  shouldAttempt: boolean,
): Promise<CodexIsolationStatus> {
  const snapshot = snapshots.find((item) => item.providerId === "openai");
  if (snapshot === undefined || snapshot.available.value !== true) {
    return Object.freeze({ attempted: false, eligible: false, attestation: null, reason: "Codex CLI is unavailable." });
  }
  if (snapshot.authState.value !== "authenticated" || snapshot.authMode.value !== "subscription") {
    return Object.freeze({ attempted: false, eligible: false, attestation: null, reason: "ChatGPT subscription authentication is not proven by `codex login status`." });
  }
  if (!shouldAttempt) {
    return Object.freeze({ attempted: false, eligible: false, attestation: null, reason: "Codex isolation self-test was not needed for this command." });
  }
  try {
    const verified = deps.verifyCodexIsolation === undefined
      ? await new CodexIsolationVerifier({ env }).verify(snapshot)
      : await deps.verifyCodexIsolation(snapshot);
    return Object.freeze({ attempted: true, eligible: true, attestation: verified, reason: null });
  } catch (error) {
    const safe = safeError(error);
    return Object.freeze({ attempted: true, eligible: false, attestation: null, reason: `${safe.code}: ${safe.message}` });
  }
}

function configuredOpenAi(state: OperatorStatePaths): boolean {
  return new ModelCatalog(state.modelCatalogPath).load().some((entry) => entry.configured && entry.providerId === "openai");
}

function runtimeFor(
  state: OperatorStatePaths,
  snapshots: readonly ProviderSnapshot[],
): { readonly router: CapabilityRouter; readonly runtimes: ReturnType<typeof hydrateModelRegistry>["runtimes"]; readonly quota: readonly ReturnType<GlobalQuotaStore["latest"]>[number][] } {
  const catalog = new ModelCatalog(state.modelCatalogPath);
  const entries = catalog.load();
  if (entries.filter((entry) => entry.configured).length === 0) {
    throw new BrainGateInvariantError("MODEL_CATALOG_EMPTY", "No configured models are available. Add a scored model definition with `braingate models add --definition <file>`. ");
  }
  const store = new GlobalQuotaStore(state.globalDir);
  try {
    const quota = store.latest();
    const hydrated = hydrateModelRegistry({ entries, providers: snapshots, quota });
    return Object.freeze({ router: new CapabilityRouter(hydrated.registry), runtimes: hydrated.runtimes, quota });
  } finally { store.close(); }
}

function snapshotProvider(state: OperatorStatePaths, project: RegisteredProject): () => DashboardSnapshot {
  return () => {
    const ledger = new TaskLedger(project);
    const quota = new GlobalQuotaStore(state.globalDir);
    try { return buildDashboardSnapshot({ projects: [{ project, ledger }], quotaStore: quota }); }
    finally { ledger.close(); quota.close(); }
  };
}

export async function runCli(argv: readonly string[], deps: CliDependencies = {}): Promise<CliResult> {
  const args = [...argv];
  const json = removeFlag(args, "--json");
  const cwd = realpathSync.native(resolve(deps.cwd ?? process.cwd()));
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  let data: unknown = null;

  try {
    const state = resolveOperatorState(env);
    const command = args.shift();
    if (command === undefined || command === "help" || command === "--help") {
      // init and dogfood are dispatched before this handler is reached, so they were absent
      // from the only listing a new user sees — which left the two commands they actually
      // need undiscoverable. The listing describes every command the binary accepts.
      data = { commands: ["init", "dogfood", "doctor", "discover", "models", "memory", "shadow", "write", "status", "dashboard"] };
      emit(
        json,
        data,
        [
          "BrainGate — one local control plane for the AI coding subscriptions you already use.",
          "",
          "Start here",
          "  braingate init                       register the repository in the current directory",
          "  braingate dogfood preflight          check readiness, zero model calls",
          '  braingate dogfood ask plan --task "<question>"',
          '  braingate dogfood ask run  --task "<question>" --execute',
          "",
          "Everything else",
          "  discover     which provider CLIs are installed and how they are authenticated",
          "  doctor       validate the project, models and reviewer isolation",
          "  models       list | validate | add | remove | import-discovered | profile",
          "  memory       preview | import | promote | list",
          "  dogfood      preflight | ask | write | feedback | report | export",
          "  shadow       read-only provider run outside the dogfood flow",
          "  write        worktree-only change outside the dogfood flow",
          "  status       recent tasks for a project",
          "  dashboard    local read-only web view",
          "",
          "plan and run without --execute make no provider model calls.",
        ].join("\n"),
        stdout,
      );
      return Object.freeze({ exitCode: 0, data });
    }

    if (command === "discover") {
      noExtraArgs(args);
      const snapshots = await discovery(deps);
      data = normalizedDiscovery(snapshots);
      emit(json, data, snapshots.map((item) => `${item.providerId}: ${item.available.value ? "available" : "missing"} · auth=${item.authMode.value}/${item.authState.value}`).join("\n"), stdout);
      return Object.freeze({ exitCode: 0, data });
    }

    if (command === "models") {
      const subcommand = args.shift();
      const catalog = new ModelCatalog(state.modelCatalogPath);
      if (subcommand === "list") {
        noExtraArgs(args);
        data = catalog.load();
        const entries = data as ReturnType<ModelCatalog["load"]>;
        emit(json, data, entries.length === 0 ? "Model catalog is empty." : entries.map((entry) => `${entry.providerId}/${entry.modelId} · ${entry.configured ? "configured" : "unscored"}`).join("\n"), stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      if (subcommand === "validate") {
        noExtraArgs(args);
        const entries = catalog.validate();
        data = { valid: true, entries: entries.length, configured: entries.filter((entry) => entry.configured).length };
        emit(json, data, `Model catalog valid: ${entries.length} entries, ${entries.filter((entry) => entry.configured).length} configured.`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      if (subcommand === "add") {
        const file = takeOption(args, "--definition", true)!;
        noExtraArgs(args);
        const definition = JSON.parse(readFileSync(resolve(cwd, file), "utf8")) as ModelDefinition;
        const entries = catalog.upsert(definition);
        data = entries.find((entry) => entry.providerId === definition.providerId && entry.modelId === definition.modelId) ?? null;
        emit(json, data, `Configured ${definition.providerId}/${definition.modelId}.`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      if (subcommand === "remove") {
        const providerId = takeOption(args, "--provider", true)!;
        const modelId = takeOption(args, "--model", true)!;
        noExtraArgs(args);
        catalog.remove(providerId, modelId);
        data = { removed: true, providerId, modelId };
        emit(json, data, `Removed ${providerId}/${modelId}.`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      if (subcommand === "import-discovered") {
        noExtraArgs(args);
        const snapshots = await discovery(deps);
        const entries = catalog.importDiscovered(snapshots);
        data = { entries: entries.length, configured: entries.filter((entry) => entry.configured).length, unscored: entries.filter((entry) => !entry.configured).length };
        emit(json, data, `Catalog now has ${entries.length} entries; ${entries.filter((entry) => !entry.configured).length} remain unscored.`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }
      throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "models requires list, validate, add, remove, or import-discovered.");
    }

    if (command === "doctor") {
      const manifest = takeOption(args, "--project", true)!;
      noExtraArgs(args);
      const project = projectFromManifest(state, manifest, cwd);
      const snapshots = await discovery(deps);
      const entries = new ModelCatalog(state.modelCatalogPath).load();
      const isolation = await codexIsolationStatus(snapshots, deps, env, true);
      const store = new GlobalQuotaStore(state.globalDir);
      let runtimes: readonly unknown[] = [];
      try { runtimes = hydrateModelRegistry({ entries, providers: snapshots, quota: store.latest() }).runtimes; }
      finally { store.close(); }
      data = {
        project: { projectId: project.projectId, name: project.name, repositories: project.repositories },
        models: { entries: entries.length, configured: entries.filter((entry) => entry.configured).length, runtimes },
        providers: snapshots.map((snapshot) => ({
          providerId: snapshot.providerId,
          available: snapshot.available.value,
          version: snapshot.version.value,
          authState: snapshot.authState.value,
          authMode: snapshot.authMode.value,
          shadow: shadowProviderStatus(snapshot.providerId),
          roles: {
            primary: shadowProviderRoleStatus(snapshot.providerId, "primary"),
            reviewer: snapshot.providerId === "openai"
              ? { enabled: isolation.eligible, reason: isolation.reason }
              : shadowProviderRoleStatus(snapshot.providerId, "reviewer"),
            judge: shadowProviderRoleStatus(snapshot.providerId, "judge"),
          },
          ...(snapshot.providerId === "openai" ? { isolation: { attempted: isolation.attempted, eligible: isolation.eligible, source: isolation.attestation?.source ?? null, profileHash: isolation.attestation?.profileHash ?? null, reason: isolation.reason } } : {}),
        })),
      };
      emit(
        json,
        data,
        `Project ${project.projectId} valid. ${entries.filter((entry) => entry.configured).length} configured models.\n${snapshots.map((item) => {
          if (item.providerId === "openai") {
            // ADR 0006: a control key this Codex build does not recognise is reported rather
            // than passed over, so a control disappearing upstream stays visible.
            const dropped = isolation.attestation?.droppedFeatureKeys ?? [];
            const note = dropped.length === 0 ? "" : ` · controls-dropped=${dropped.join(",")}`;
            return `${item.providerId}: ${item.available.value ? "available" : "missing"} · reviewer=${isolation.eligible ? "verified" : "blocked"}${note}`;
          }
          return `${item.providerId}: ${item.available.value ? "available" : "missing"} · shadow=${shadowProviderStatus(item.providerId).enabled ? "enabled" : "blocked"}`;
        }).join("\n")}`,
        stdout,
      );
      return Object.freeze({ exitCode: 0, data });
    }

    if (command === "status") {
      const manifest = takeOption(args, "--project", true)!;
      noExtraArgs(args);
      const project = projectFromManifest(state, manifest, cwd);
      data = snapshotProvider(state, project)();
      const dashboard = data as DashboardSnapshot;
      emit(json, data, `BrainGate ${project.projectId}: ${dashboard.activeTasks.length} active, ${dashboard.recentTasks.length} recent tasks.`, stdout);
      return Object.freeze({ exitCode: 0, data });
    }

    if (command === "dashboard") {
      const manifest = takeOption(args, "--project", true)!;
      const portRaw = takeOption(args, "--port");
      noExtraArgs(args);
      const project = projectFromManifest(state, manifest, cwd);
      const port = portRaw === undefined ? 0 : Number(portRaw);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new BrainGateInvariantError("CLI_PORT_INVALID", "--port must be an integer from 0 to 65535.");
      const starter = deps.startDashboard ?? (async (provider, options) => await startDashboardServer(provider, options));
      const started = await starter(snapshotProvider(state, project), { host: "127.0.0.1", port });
      data = { url: started.url, projectId: project.projectId };
      emit(json, data, `BrainGate dashboard: ${started.url}`, stdout);
      return Object.freeze({ exitCode: 0, data });
    }

    if (command === "write") {
      const subcommand = args.shift();
      if (subcommand !== "plan" && subcommand !== "run") throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "write requires plan or run.");
      const manifest = takeOption(args, "--project", true)!;
      const task = takeOption(args, "--task", true)!;
      const requestedRepo = takeOption(args, "--repo");
      const baseRef = takeOption(args, "--base") ?? "HEAD";
      const execute = removeFlag(args, "--execute");
      const review = !removeFlag(args, "--no-review");
      const attestations = attestation(args);
      noExtraArgs(args);
      if (subcommand === "plan" && execute) throw new BrainGateInvariantError("CLI_EXECUTE_INVALID", "--execute is valid only with `write run`.");

      const project = projectFromManifest(state, manifest, cwd);
      const repositoryPath = resolveWriteRepository(project, cwd, requestedRepo);
      const snapshots = await discovery(deps);
      const hydrated = runtimeFor(state, snapshots);
      const classification = classifyTask({ text: task, mode: "write" });
      const budget = budgetFor(classification, { writeRequested: true });
      const requiredContextTokens = contextTokens(task);
      const isolation = await codexIsolationStatus(snapshots, deps, env, review && configuredOpenAi(state));
      const codexIsolation = isolation.attestation ?? undefined;
      const plan = buildWriteTaskPlan({
        router: hydrated.router,
        providers: snapshots,
        ...(codexIsolation === undefined ? {} : { codexIsolation }),
        classification,
        budget,
        requiredContextTokens,
        repositoryPath,
        baseRef,
        review,
      });
      const planData = serializedWritePlan(plan);

      if (subcommand === "plan" || !execute) {
        data = { ...planData, codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason }, approvalRequired: true };
        emit(json, data, `${classification.complexity}/${classification.risk} · ${plan.roles.map((role) => `${role.role}=${role.model.providerId}/${role.model.modelId}`).join(" · ")}\nZero provider model calls. Zero worktrees. Merge unavailable.`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }

      if (!json) stdout(`${classification.complexity}/${classification.risk} · creating isolated worktree · ${plan.roles.map((role) => `${role.role}=${role.model.providerId}/${role.model.modelId}`).join(" · ")}\n`);
      const ledger = new TaskLedger(project);
      try {
        const runner = new WriteDogfoodRunner({
          project,
          ledger,
          router: hydrated.router,
          providers: snapshots,
          attestations,
          ...(codexIsolation === undefined ? {} : { codexIsolation }),
          ...(deps.writeExecutor === undefined ? {} : { writer: deps.writeExecutor }),
          ...(deps.executor === undefined ? {} : { reviewExecutor: deps.executor }),
        });
        const result = await runner.run({
          task,
          repositoryPath,
          baseRef,
          classification,
          budget,
          requiredContextTokens,
          context: writeTaskContext(project),
          review,
          dryRun: false,
          env,
        });
        data = {
          plan: planData,
          taskId: result.taskId,
          worktree: result.worktree,
          changedFiles: result.changedFiles,
          diff: result.diff,
          verification: result.verification,
          review: result.review,
          readyForApproval: result.readyForApproval,
          approvalRequired: result.approvalRequired,
          mergePerformed: result.mergePerformed,
          usage: result.taskReceipt?.usage ?? [],
        };
        const reviewText = result.review === null ? "review=disabled" : `review=${result.review.providerId}/${result.review.modelId}:${result.review.verdict}`;
        emit(json, data, `Task ${result.taskId} · branch=${result.worktree?.branch ?? "unknown"}\nChanged: ${result.changedFiles.join(", ")}\n${reviewText}\nReady for human approval: ${result.readyForApproval ? "yes" : "no"}. No merge performed.`, stdout);
        return Object.freeze({ exitCode: result.readyForApproval ? 0 : 1, data });
      } finally { ledger.close(); }
    }

    if (command === "shadow") {
      const subcommand = args.shift();
      if (subcommand !== "plan" && subcommand !== "run") throw new BrainGateInvariantError("CLI_SUBCOMMAND_INVALID", "shadow requires plan or run.");
      const manifest = takeOption(args, "--project", true)!;
      const task = takeOption(args, "--task", true)!;
      const execute = removeFlag(args, "--execute");
      const optionalReview = removeFlag(args, "--review");
      const attestations = attestation(args);
      noExtraArgs(args);
      if (subcommand === "plan" && execute) throw new BrainGateInvariantError("CLI_EXECUTE_INVALID", "--execute is valid only with `shadow run`.");
      const project = projectFromManifest(state, manifest, cwd);
      const snapshots = await discovery(deps);
      const hydrated = runtimeFor(state, snapshots);
      const classification = classifyTask({ text: task, mode: "ask" });
      const budget = budgetFor(classification, { writeRequested: false });
      const requiredContextTokens = contextTokens(task);
      const context = taskContext(project);
      const needsReview = budget.reviewerPolicy === "required" || (budget.reviewerPolicy === "optional" && optionalReview);
      const isolation = await codexIsolationStatus(snapshots, deps, env, needsReview && configuredOpenAi(state));
      const codexIsolation = isolation.attestation ?? undefined;
      const plan = buildShadowTaskPlan({
        project, cwd, router: hydrated.router, providers: snapshots, attestations, task, context,
        classification, budget, requiredContextTokens, optionalReview,
        ...(codexIsolation === undefined ? {} : { codexIsolation }),
      });
      const planData = serializedPlan(plan);

      if (subcommand === "plan" || !execute) {
        data = { ...planData, codexIsolation: { attempted: isolation.attempted, eligible: isolation.eligible, reason: isolation.reason } };
        emit(json, data, `${classification.complexity}/${classification.risk} · ${plan.roles.map((role) => `${role.role}=${role.model.providerId}/${role.model.modelId}`).join(" · ")}\nZero provider model calls executed.`, stdout);
        return Object.freeze({ exitCode: 0, data });
      }

      if (!json) stdout(`${classification.complexity}/${classification.risk} · executing ${plan.roles.map((role) => `${role.role}=${role.model.providerId}/${role.model.modelId}`).join(" · ")}\n`);
      const ledger = new TaskLedger(project);
      try {
        const runner = new ShadowDogfoodRunner({
          project,
          ledger,
          router: hydrated.router,
          snapshots,
          attestations,
          ...(codexIsolation === undefined ? {} : { codexIsolation }),
          ...(deps.executor === undefined ? {} : { executor: deps.executor }),
        });
        const result = await runner.run({
          title: `Shadow ${classification.complexity} task`,
          task,
          cwd,
          classification,
          budget,
          requiredContextTokens,
          context,
          contextSummary: { memoryRecords: 0, explicitCandidates: 0, includedItems: 1, estimatedTokens: requiredContextTokens, truncatedItems: 0, sourceLabels: ["operator-minimal-context"] },
          optionalReview,
          dryRun: false,
        });
        data = {
          plan: planData,
          taskId: result.taskId,
          outcome: result.workflow?.outcome ?? null,
          answer: result.workflow?.finalOutput ?? null,
          usage: result.taskReceipt.usage,
        };
        emit(json, data, `${result.workflow?.finalOutput ?? "No answer returned."}\n\nTask ${result.taskId} · outcome=${result.workflow?.outcome ?? "unknown"}`, stdout);
        return Object.freeze({ exitCode: 0, data });
      } finally { ledger.close(); }
    }

    throw new BrainGateInvariantError("CLI_COMMAND_INVALID", `Unknown BrainGate command: ${command}.`);
  } catch (error) {
    const safe = safeError(error);
    data = { error: safe };
    stderr(json ? `${JSON.stringify(data, null, 2)}\n` : `BrainGate ${safe.code}: ${safe.message}\n`);
    return Object.freeze({ exitCode: 1, data });
  }
}
