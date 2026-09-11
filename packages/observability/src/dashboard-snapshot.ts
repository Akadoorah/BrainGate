import {
  BrainGateInvariantError,
  finalizedSnapshotOf,
  type RegisteredProject,
  type TaskLedger,
  type TaskOutcome,
  type TaskState,
  type UsageEvidence,
} from "@braingate/core";
import { GlobalQuotaStore, type QuotaSnapshot, type QuotaStatus } from "./quota-store.js";
import { normalizeTaskReceipt, type NormalizedTaskReceipt } from "./task-brief.js";

const ACTIVE_STATES = new Set<TaskState>(["created", "planned", "running", "verifying"]);
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
  /** The workflow's own phrase, kept for the surfaces that already read it. */
  readonly outcome: string | null;
  /**
   * What BrainGate decided about this task, as the finalization marker recorded it.
   *
   * `null` means no readable marker — still running, or stopped before one could be written. That
   * is not the same as an outcome of UNKNOWN, which is a decision that *was* made and written down.
   * The absence of a decision has a next step (`braingate tasks reconcile`); UNKNOWN does not.
   */
  readonly strictOutcome: TaskOutcome | null;
  readonly reviewStatus: string | null;
  readonly failureKind: string | null;
  readonly reconciled: boolean;
  readonly usageProvenance: readonly UsageEvidence[];
  /**
   * What each model in the route actually cost, when the provider counted it itself.
   *
   * `null` where it did not: an absent number is the honest answer, and a zero would read as a
   * free call. This is the other half of "who did what" — the roles say who, this says at what
   * price, which is the whole reason routing across subscriptions is worth doing.
   */
  readonly tokensByModel: readonly {
    readonly providerId: string;
    readonly modelId: string;
    readonly tokens: number | null;
    readonly evidence: UsageEvidence;
  }[];
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

function tokensByModel(receipt: NormalizedTaskReceipt): DashboardTaskCard["tokensByModel"] {
  const totals = new Map<string, { providerId: string; modelId: string; tokens: number | null; evidence: UsageEvidence }>();
  for (const usage of receipt.usage) {
    if (usage.metric !== "provider_tokens" || usage.model === null) continue;
    const key = `${usage.provider}\u0000${usage.model}`;
    const current = totals.get(key);
    const value = usage.value;
    if (current === undefined) {
      totals.set(key, { providerId: usage.provider, modelId: usage.model, tokens: value, evidence: usage.evidence });
      continue;
    }
    // One model may be called more than once in a task. A run the provider did not count makes
    // the total for that model unknown rather than a partial sum presented as a whole.
    current.tokens = current.tokens === null || value === null ? null : current.tokens + value;
    if (usage.evidence !== current.evidence) current.evidence = "unknown";
  }
  return Object.freeze([...totals.values()].map((entry) => Object.freeze(entry)));
}

export function buildTaskCard(project: RegisteredProject, receipt: NormalizedTaskReceipt): DashboardTaskCard {
  if (receipt.task.projectId !== project.projectId) {
    throw new BrainGateInvariantError("DASHBOARD_PROJECT_MISMATCH", "Task card cannot mix project identities.");
  }
  const workflow = receipt.workflow;
  const brief = receipt.brief;
  // Read from the marker rather than re-derived: the writer already decided, and two derivations
  // of the same evidence are two answers waiting to disagree.
  const finalized = finalizedSnapshotOf(receipt.events);
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
    strictOutcome: finalized?.outcome ?? null,
    reviewStatus: finalized?.reviewStatus ?? null,
    failureKind: finalized?.failureKind ?? null,
    reconciled: finalized?.reconciled ?? false,
    usageProvenance: uniqueSorted(receipt.usage.map((usage) => usage.evidence)),
    tokensByModel: tokensByModel(receipt),
  });
}

function providerCards(snapshots: readonly QuotaSnapshot[], now: number): readonly ProviderQuotaCard[] {
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
    // The same boundary routing draws, with the same freshness rule: only a refusal the provider
    // stated, with the provider's own evidence, in a window that has not reset, is current
    // availability. A legacy `healthy`/`limited` label records what this code once inferred from its
    // own traffic and never becomes availability; an `exhausted` row whose window has passed is
    // history like any other. `now` is the snapshot's own `generatedAt`, so a replayed snapshot is
    // judged at the moment it was built and an unreadable clock cannot promote an expired refusal.
    // Every metric row below still renders with its own status, evidence, timestamp and reset.
    const current = group.filter((item) => item.resetAt === null || Date.parse(item.resetAt) > now);
    const status: QuotaStatus = current.some((item) => item.evidence === "native" && item.status === "exhausted") ? "exhausted" : "unknown";
    const observedAt = [...group].sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]!.observedAt;
    // The card's own reset describes the window the card is speaking about, so it comes from the rows
    // that are still current: a date that has already passed is not a fact about now, and pairing one
    // with a status would describe a window nobody is in.
    const resetAt = current.map((item) => item.resetAt).filter((value): value is string => value !== null).sort()[0] ?? null;
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
  // One clock read for the whole snapshot, and the cards are judged against that same instant rather
  // than against a second one taken later: `generatedAt` is what a reader is told this snapshot
  // describes, and two times in one snapshot is how a card and its own timestamp disagree.
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return Object.freeze({
    generatedAt,
    providers: providerCards(input.quotaStore.latest(), Date.parse(generatedAt)),
    activeTasks: Object.freeze(active),
    recentTasks: Object.freeze(cards.slice(0, recentLimit)),
    provenanceLegend: Object.freeze(["native", "measured", "estimated", "unknown"] as const),
  });
}
