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

GitHub Copilot remains its own quota pool even when the underlying selected model is from another model family.

## Dashboard safety

The local dashboard consumes a pre-built `DashboardSnapshot`. Rendering does not run discovery commands or provider CLIs. The HTTP server binds only to `127.0.0.1` or `::1`, escapes all dynamic HTML, disables caching, and sends a restrictive Content Security Policy.
