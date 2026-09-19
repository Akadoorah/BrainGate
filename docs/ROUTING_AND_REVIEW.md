# Capability routing and bounded review

BrainGate never chooses a model merely because its marketing name is newer or larger. Provider-owned model IDs remain opaque strings. Routing uses stable role capabilities, task complexity/risk, context capacity, write support, runtime availability, quota pressure, the execution policy the run executes under, and the goal's own sessions.

## The policy gate and the continuity preference (M22)

Two routing facts used to be decided elsewhere and dropped:

- **The execution policy is a hard filter.** A provider whose installed build cannot run the requested
  policy is excluded by name, for every role — planner, primary, reviewer and judge alike, because under
  DIRECT every role keeps the runtime's own harness. `/use` on such a provider is refused with the reason
  rather than silently satisfied by another model. Which providers can run DIRECT is measured per
  machine, not assumed: Claude, Codex and Grok by their invocations, Antigravity by whether its own
  settings allow headless reads and shell commands (ADR 0020).
- **A warm session is a preference, not a rule.** A worker that already holds the goal — its files
  and decisions loaded in a native session — is worth about thirteen capability points, enough to
  keep the goal with it and not enough to keep a task with a worker that cannot do it. The preference
  is produced where the goal lives (the store answers which sessions the request's envelope may
  resume; the session says who answered the last turn) and travels through the plan to the route.

The task brief records the winner's own reasons (`continuity:warm-session`,
`continuity:previous-worker`, and the rest) beside every loser's, so "why this one?" is answered
from the record rather than reconstructed from a score nobody kept.

## The route explains itself (`/why`, M23 Phase D)

The task brief's route is now visible in the session, not only in a task's stored receipt:

- **`/why`** prints the last plan's route, per role — the selected model with its `selectedReasons`,
  and every rejected candidate with its own `reasons` (the router's own vocabulary: `capability:72`,
  `quota-pool-backoff:claude-subscription`, and the rest). It answers right after a plan is shown,
  before the operator has confirmed anything, because the plan is where the routing decision was
  made; after a run it answers from the ledger's own `task.brief` event instead, which is the record
  of what actually executed rather than what was proposed. `/why <task-id-prefix>` answers for a past
  task the same way.
- **The write runner records a brief too.** Before this it recorded none — a write task's route lived
  only in the plan JSON printed before the run, gone the moment the process exited — so `/why` after a
  write now reads the same shape from the ledger that `/why` after a read always could.
- **The plan JSON carries `route` and `backoffLines`** for both `dogfood ask plan` and
  `dogfood write plan`, so a caller reading the plan back (the interactive session does) gets the
  routing reasons and any active refusal backoff without a second call.

## Quota ownership

Quota belongs to the provider path actually being used. A Claude-family model invoked through GitHub Copilot consumes the Copilot quota pool, not the user's direct Anthropic pool. `underlyingFamily` is advisory metadata only and never merges quota accounting.

Quota states are ranked conservatively:

- `healthy`: normal candidate
- `limited`: eligible with a substantial penalty
- `unknown`: eligible, but never assumed free/unlimited
- `exhausted`: ineligible

## Complexity floors

Higher task tiers require progressively higher capability scores. High/critical risk also raises the floor. Low-complexity work rewards fast sufficient models so strong quota is preserved for harder tasks.

## Independent review

For high/critical tasks, a reviewer must be from a different provider and quota pool than the primary. Lower-risk review prefers independence but may fall back when policy allows it.

## Council

Council is not a default execution mode. T0-T3 budgets currently disable it. T4 allows at most one disagreement-only judge round. The judge is selected with a strong preference for a provider/quota pool distinct from both primary and reviewer.

## Repair semantics

Reviewer findings are bounded before being returned to the primary. If the task budget does not allow another independent review after a repair, BrainGate returns `repaired_needs_review` instead of pretending the repaired work is automatically approved.

## Security gate

Providers are executed, not merely planned for: read-only invocations run today, and write-capable
execution runs inside worktrees once the isolation gate in `SAFE_EXECUTION.md` is satisfied and the
provider is scored for the role (M11, M16). What a role may do is a *grant* earned per role, not a
property of the provider — ADR [0010](adr/0010-tool-grants-are-earned-per-role.md) — and, since
ADR [0014](adr/0014-native-runtime-preservation.md), the default interactive posture preserves the
native runtime's own capabilities while an explicit policy overlay is what narrows them.

## Where quota pressure comes from

For a long time no provider published a remaining balance, so pressure was `unknown` for every
pool and routing never moved: the strongest model won every role until its pool ran out for real.

**One does now.** Measured 2026-09-10 against claude 2.1.266: every headless run emits a
`rate_limit_event` before its answer, carrying `unifiedWindows.five_hour.utilization` and
`seven_day.utilization` with the time each rolls over. That is a real reading rather than a
comparison, it costs nothing to obtain, and it is recorded as `pressure` with `native` evidence —
which the rule below already said outranks the local signal.

Where a provider reports more than one window, the fullest decides, because that is the window
that will refuse first: a five-hour window at 0.9 is a pool to route away from now, whatever the
weekly figure says. The other windows are kept under their own metric so a receipt can say what
was reported without them competing for the routing decision. A run the provider refuses marks
the pool exhausted; utilization alone never does — it decides where work goes, not whether the
pool is up.

BrainGate knows one thing about quota — what it spent itself — and provider token counts are
recorded natively. Pools are therefore compared against each other: the busiest recent pool
scores 1, the quietest 0, and the router leans away from the busy one.

This is a relative signal and is labelled as one. It claims to know no pool's limit.

- A provider that reports a real balance outranks it. The local reading lives under its own
  metric name as `measured`, never as `pressure`, so a receipt can say which was used.
- A pool nobody measured scores `null`, not 0. Codex and Copilot report no token counts, and
  reading silence as "idle" would send them everything.
- One measured pool is not a comparison and produces no signal.

## Which model gets a cheap question

At T0 and T1 the capability floor has already answered "can this model do it". What remains is
which qualifying model to spend, and the answer is the cheapest one — so speed is the deciding
term there, not a tiebreak. T2 — ordinary work, and every write, since a write starts at T2 —
keeps a little over half of the capability range in play, so a balanced model wins a simple append
and a genuinely harder T2 still reaches the strong end. From T3 up the preference inverts fully: a
T3 audit gets the model that is actually better at it, because there the work is what costs.
