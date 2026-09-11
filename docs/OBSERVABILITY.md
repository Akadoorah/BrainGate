# Observability, task briefs, and quota truth

BrainGate observability is designed around one rule: **unknown is better than invented precision**.

## Before execution

A `TaskBrief` records what BrainGate intends to do without dumping prompts or project content. It includes:

- project/task identity,
- T0–T4 complexity and risk,
- hard Budget Governor limits,
- selected provider/model/quota pool per role,
- context counts and estimated token budget,
- loaded/denied skill IDs,
- execution profile, network flag, approval state, and worktree label.

The brief is persisted as a `task.brief` event in the existing project `TaskLedger`. There is no second task database.

## After execution

A workflow receipt is reduced to a safe summary before it is persisted as `workflow.receipt`. The summary keeps role/model choices, outcome, event kinds, and budget counters, but deliberately excludes the agent's final output and raw review text.

The dashboard normalizes these events with the existing task/usage ledger into a receipt view.

## Quota snapshots

Subscription quota belongs to a provider/account quota pool, not to a project. Global snapshots therefore live in a separate append-only `quota.sqlite` under BrainGate's global state directory.

Every quota metric stores provenance:

- `native`: reported by the provider,
- `measured`: directly observed by BrainGate,
- `estimated`: calculated from known observations,
- `unknown`: the provider did not expose a trustworthy value.

`unknown` metrics carry no numeric value. BrainGate never renders them as 100%, 0%, or any guessed token balance.

**A pool's state is only ever what a provider said.** Routing reads `quotaState` from readings with
`native` evidence and from nothing else; a status BrainGate derived from its own traffic is history —
kept, visible, and not a reason to route anywhere. `unknown` carries no penalty: demoting a pool
nobody has a reading for would be a routing decision made on the absence of information. See ADR 0012.

**A reading belongs to a window.** A row whose `resetAt` has passed is dropped from the current view
rather than aged by arithmetic: BrainGate does not know the shape of a window it never measured, and a
decay rate it invented would be a reading it never took with a timestamp attached.

Two metrics follow from that split. `window_utilization` is how full a provider's window looked when it
last said so; it is exposed as `quotaHint` together with `quotaObservedAt`, and routing uses it as a
small tiebreaker. `pressure` claims to be a current level of the pool and is refused alongside an
unknown status, so BrainGate no longer writes it.

**A refusal must be recordable.** A failed provider call appends a bounded, redacted failure record —
`failureKind`, exit code, timeout, duration, and bounded stderr/stdout tails — so a refusal BrainGate
does not yet understand is still diagnosable afterwards from the words the provider used. No failure
text is pattern-matched into a state; `exhausted` is persisted only for a window the provider itself
reported as refused, and it expires with that window's own reset.

**The decision records the belief behind it.** Every task brief carries, per role, the `quotaState`,
`quotaHint` and `quotaObservedAt` the choice was made under, along with the candidates that lost and
why. Without that, "dispatched to a pool we thought was fine" and "dispatched to a pool we knew was
exhausted" read the same afterwards.

GitHub Copilot remains its own quota pool even when the underlying selected model is from another model family.

## Dashboard safety

The local dashboard consumes a pre-built `DashboardSnapshot`. Rendering does not run discovery commands or provider CLIs. The HTTP server binds only to `127.0.0.1` or `::1`, escapes all dynamic HTML, disables caching, and sends a restrictive Content Security Policy.
