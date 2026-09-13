# Architecture

## System boundary

BrainGate is deterministic orchestration software. It is not itself an LLM. Provider models are external workers accessed through supported official CLI processes authenticated by the user.

**BrainGate orchestrates coarsely; the native runtime executes finely.** A work unit is dispatched to
one CLI, and that CLI uses its own tools, shell, subagents, MCP servers, browser and worktrees to
carry it out. BrainGate accounts for the dispatch and reads whatever usage the runtime reports; it
does not micromanage what happens inside. Where a boundary is needed it is applied as an explicit
policy overlay — requested by the operator, or required because nobody is present to approve a
runtime action — and every overlay is visible in the plan before anything is spent. ADR
[0014](adr/0014-native-runtime-preservation.md) states this, and classifies every restriction that
exists today.

Session continuity follows the same division: a provider owns its own session storage, and BrainGate
stores only the reference that connects a goal to it. Cross-provider continuity is carried by the
goal's shared state and never depends on any runtime's ability to resume.

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

## Conversation, Goal and Task

M20 put a level above the task. A **Conversation** is the session a person is having; a **Goal** is
what they are trying to achieve in it; a **Task** is one work unit of that goal. The three are
project-scoped and persisted in the project's own `storage_dir` (`goals.sqlite`), never shared
across projects.

The distinction that matters is between a **worker claim** and an **accepted finding**. A goal's
state holds findings BrainGate treats as established, findings established but *not* the active
cause, and contrary claims that have not displaced either. A worker that asserts a different root
cause is recorded as `conflicting` beside the established one; it does not overwrite it. Replacing
an accepted finding is reconciliation, which is a later milestone and deliberately absent here.

Continuity across providers is carried by a **handoff package** derived from that state — findings
with their evidence, what changed, what ran, what is unresolved — and by a registry of native
provider sessions. A handoff carries engineering state and never hidden reasoning. Where a
provider's own session can be resumed, that is recorded as a fact about the session; nothing
resumes one yet, and the registry says so rather than implying otherwise.

A follow-up also inherits the complexity of the goal it continues. `max(prompt, goal)` is the rule:
a short follow-up can never be budgeted below the goal it belongs to, and one that introduces new
risk still raises it. Routing, budgets, grants, isolation and finalization are unchanged and remain
where they were.

## Execution lifecycle

1. Resolve an explicit project identity, and the conversation and goal this request continues.
2. Create a task ledger record, linked to that goal.
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
14. Finalize: write the result, record the observation, write the marker, then the terminal state —
    in that order, each step idempotent, so a crash at any point is finished by `reconcile`.
15. Report the recorded outcome, which is the only thing any surface may present as what happened.
16. Fold the turn into the goal's state, and record where each provider session got to.

Steps 2 and 16 are what make a follow-up a continuation: the task is a work unit *of* a goal, and the
goal's state — accepted findings, disputed claims, files changed, tests run — is what the next worker
is handed, whichever runtime it belongs to.

## Finalization and reconciliation

The three places a task's record lives — `tasks.sqlite`, `dogfood.sqlite`, and the result files — are
all opened with WAL, and WAL forfeits atomic commit across databases. There is no transaction that can
span them, so the record is written as a fixed sequence of idempotent steps and a reconciler completes
any prefix of it. See ADR 0011.

Two recovery classes are distinguished by their evidence: a record that was begun and not finished
(a result file, a `task.result` claim, or an observation) is repaired immediately, because durability
of any one of them proves the run is over; a task with no evidence at all is repaired only once it has
been silent past `3 × MAX_PROVIDER_CALL_MS`, because only there can a run still be working.

Outcomes, review status and ledger states are three separate vocabularies (`packages/core/src/task-outcome.ts`),
each derived from an exported runtime list so a guard and a type cannot drift. `braingate tasks list`,
`tasks show` and `tasks reconcile` are the operator's read and repair surface; read-only commands
report `Reconciliation required: N task(s)` and append nothing.

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
