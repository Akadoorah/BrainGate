# Architecture

## System boundary

BrainGate is deterministic orchestration software. It is not itself an LLM. Provider models are external workers accessed through supported official CLI processes authenticated by the user.

```text
User
  |
BrainGate
  |-- Project Guard
  |-- Task Classifier
  |-- Risk Governor
  |-- Budget Governor
  |-- Context Builder
  |-- Model Router
  |-- Task Ledger
  |-- Memory Manager
  |-- Skill Firewall
  |-- Secret Guard
  |-- Worktree Manager
  `-- Provider Adapters
       |-- Claude Code
       |-- Codex CLI
       |-- Antigravity CLI
       `-- Grok Build
```

## Execution lifecycle

1. Resolve an explicit project identity.
2. Create a task ledger record.
3. Classify task intent, complexity, risk, read/write needs, and confidence.
4. If confidence is low, run a bounded cheap scout and reclassify.
5. Build a minimal context pack from project-scoped sources.
6. Allocate a policy budget before provider execution.
7. Route to the least expensive capable available role.
8. For writes, create an isolated worktree.
9. Execute and verify.
10. Add a reviewer only when policy requires one.
11. Invoke a council/judge only for material disagreement or explicit user request.
12. Produce a receipt and propose memory updates.
13. Validate canonical memory updates through the single writer.

## Complexity tiers

- **T0:** trivial lookup/explanation; local retrieval or one fast worker.
- **T1:** small project question; one fast worker.
- **T2:** normal bug/change; one capable worker, reviewer optional.
- **T3:** complex feature/debugging; primary + reviewer, bounded repairs.
- **T4:** architecture/security/auth/billing/migrations; independent review and explicit approval gates.

Tasks may escalate or de-escalate after inspection. The ledger records why.

## Core packages

Planned boundaries:

- `core`: domain contracts and orchestration state machine.
- `projects`: project registry and explicit identity resolution.
- `classifier`: intent/complexity/risk classification.
- `budget`: execution and quota policy.
- `router`: capability-based provider/model selection.
- `context`: bounded retrieval and context-pack assembly.
- `memory`: project memory and canonical write validation.
- `ledger`: event/audit/task receipt storage.
- `skills`: skill registry and hard authorization.
- `sandbox`: filesystem/process/secret boundaries.
- `git`: worktree lifecycle and diff metadata.
- `providers`: official CLI adapters and usage telemetry.
- `council`: optional disagreement resolution.
- `visual`: later image/visual worker routing.

## Source of truth hierarchy

When sources disagree, use the strongest current evidence:

1. Current repository code and tests.
2. Explicit project configuration and accepted ADRs.
3. Verified canonical memory tied to source/commit.
4. Task summaries.
5. Conversation/session summaries.

LLM summaries alone are never authoritative.

## Model registry

Core policy targets capabilities (`fast_reader`, `coder`, `architect`, `reviewer`, `judge`, `vision`, `image`) rather than fixed model names. Provider adapters discover currently available models and expose normalized capabilities/telemetry.
