# ADR 0001: BrainGate core is deterministic orchestration software

Status: Accepted

## Decision

BrainGate core will not be an LLM agent. Deterministic software owns project resolution, policy, budgets, permissions, routing state, ledger events, and memory validation. LLMs are replaceable workers invoked behind provider adapters.

## Consequences

Provider outages or model changes do not redefine system behavior. Core behavior can be unit-tested without provider access. Ambiguous semantic classification may use a bounded cheap model, but policy remains deterministic.
