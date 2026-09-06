# ADR 0005: Multi-agent execution is bounded and escalation-based

Status: Accepted

## Decision

BrainGate allocates an execution budget before provider calls. Low-complexity tasks use one cheap/capable worker. Reviewers and councils are added only by risk/complexity policy or explicit user request.

Initial policy targets:

- T0/T1: one worker, one round.
- T2: one primary; reviewer optional.
- T3: primary + reviewer; maximum two repair rounds.
- T4: independent review, maximum three workers, explicit approval gates.
- Automatic retries: one unless a provider-specific transient-error policy says otherwise.

## Consequences

The system optimizes subscription quota and prevents unbounded agent loops. Escalation/de-escalation reasons are recorded in the task ledger.
