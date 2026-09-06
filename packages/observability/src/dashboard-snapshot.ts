import {
  BrainGateInvariantError,
  type RegisteredProject,
  type TaskLedger,
  type TaskState,
  type UsageEvidence,
} from "@braingate/core";
import { GlobalQuotaStore, type QuotaSnapshot, type QuotaStatus } from "./quota-store.js";
import { normalizeTaskReceipt, type NormalizedTaskReceipt } from "./task-brief.js";

const ACTIVE_STATES = new Set<TaskState>(["created", "planned", "running", "verifying"]);
const STATUS_RANK: Readonly<Record<QuotaStatus, number>> = { healthy: 0, unknown: 1, limited: 2, exhausted: 3 };

export interface ProviderQuotaCard {
  readonly provider: string;
  readonly quotaPool: string;
  readonly status: QuotaStatus;
  readonly observedAt: string;
  readonly resetAt: string | null;
  readonly provenances: readonly UsageEvidence[];
  readonly metrics: readonly QuotaSnapshot[];
}

export interface DashboardTaskCard {
  readonly taskId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly state: TaskState;
  readonly complexity: string | null;
  readonly risk: string | null;
  readonly updatedAt: string;
  readonly route: readonly {
    readonly role: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly quotaPool: string;
  }[];
  readonly budget: {
    readonly providerCalls: number;
    readonly repairRounds: number;
    readonly councilRounds: number;
    readonly contextTokens: number;
  } | null;
  readonly approvalStatus: string | null;
  readonly outcome: string | null;
  readonly usageProvenance: readonly UsageEvidence[];
}

export interface DashboardSnapshot {
  readonly generatedAt: string;
  readonly providers: readonly ProviderQuotaCard[];
  readonly activeTasks: readonly DashboardTaskCard[];
  readonly recentTasks: readonly DashboardTaskCard[];
  readonly provenanceLegend: readonly UsageEvidence[];
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort() as T[]);
}

export function buildTaskCard(project: RegisteredProject, receipt: NormalizedTaskReceipt): DashboardTaskCard {
  if (receipt.task.projectId !== project.projectId) {
    throw new BrainGateInvariantError("DASHBOARD_PROJECT_MISMATCH", "Task card cannot mix project identities.");
  }
  const workflow = receipt.workflow;
  const brief = receipt.brief;
  return Object.freeze({
    taskId: receipt.task.taskId,
    projectId: project.projectId,
    projectName: project.name,
    title: receipt.task.title,
    state: receipt.task.state,
    complexity: receipt.task.complexity,
    risk: receipt.task.risk,
    updatedAt: receipt.task.updatedAt,
    route: Object.freeze((workflow?.roles ?? brief?.route ?? []).map((role) => Object.freeze({
      role: role.role,
      providerId: role.providerId,
      modelId: role.modelId,
      quotaPool: role.quotaPool,
    }))),
    budget: workflow === null ? null : Object.freeze({
      providerCalls: workflow.budget.providerCalls,
      repairRounds: workflow.budget.repairRounds,
      councilRounds: workflow.budget.councilRounds,
      contextTokens: workflow.budget.contextTokens,
    }),
    approvalStatus: brief?.permissions.humanApprovalStatus ?? null,
    outcome: workflow?.outcome ?? null,
    usageProvenance: uniqueSorted(receipt.usage.map((usage) => usage.evidence)),
  });
}

function providerCards(snapshots: readonly QuotaSnapshot[]): readonly ProviderQuotaCard[] {
  const groups = new Map<string, QuotaSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.provider}\u0000${snapshot.quotaPool}`;
    const group = groups.get(key) ?? [];
    group.push(snapshot);
    groups.set(key, group);
  }
  const cards: ProviderQuotaCard[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.metric.localeCompare(b.metric) || (a.window ?? "").localeCompare(b.window ?? ""));
    const first = group[0]!;
    const status = group.reduce<QuotaStatus>((current, item) => STATUS_RANK[item.status] > STATUS_RANK[current] ? item.status : current, "healthy");
    const observedAt = [...group].sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]!.observedAt;
    const resetAt = group.map((item) => item.resetAt).filter((value): value is string => value !== null).sort()[0] ?? null;
    cards.push(Object.freeze({
      provider: first.provider,
      quotaPool: first.quotaPool,
      status,
      observedAt,
      resetAt,
      provenances: uniqueSorted(group.map((item) => item.evidence)),
      metrics: Object.freeze(group),
    }));
  }
  cards.sort((a, b) => a.provider.localeCompare(b.provider) || a.quotaPool.localeCompare(b.quotaPool));
  return Object.freeze(cards);
}

export function buildDashboardSnapshot(input: {
  projects: readonly { readonly project: RegisteredProject; readonly ledger: TaskLedger }[];
  quotaStore: GlobalQuotaStore;
  recentLimit?: number;
  generatedAt?: string;
}): DashboardSnapshot {
  const recentLimit = Math.max(1, Math.min(100, Math.floor(input.recentLimit ?? 20)));
  const cards: DashboardTaskCard[] = [];
  const seenProjects = new Set<string>();
  for (const entry of input.projects) {
    if (seenProjects.has(entry.project.projectId)) {
      throw new BrainGateInvariantError("DASHBOARD_PROJECT_DUPLICATE", `Project ${entry.project.projectId} was supplied more than once.`);
    }
    seenProjects.add(entry.project.projectId);
    for (const task of entry.ledger.listTasks()) {
      if (task.projectId !== entry.project.projectId) {
        throw new BrainGateInvariantError("DASHBOARD_PROJECT_MISMATCH", "Ledger returned a task for a different project.");
      }
      cards.push(buildTaskCard(entry.project, normalizeTaskReceipt(entry.ledger.receipt(task.taskId))));
    }
  }
  cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.projectId.localeCompare(b.projectId) || a.taskId.localeCompare(b.taskId));
  const active = cards.filter((card) => ACTIVE_STATES.has(card.state));
  return Object.freeze({
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    providers: providerCards(input.quotaStore.latest()),
    activeTasks: Object.freeze(active),
    recentTasks: Object.freeze(cards.slice(0, recentLimit)),
    provenanceLegend: Object.freeze(["native", "measured", "estimated", "unknown"] as const),
  });
}
