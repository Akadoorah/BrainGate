# ADR 0019 — A write is a first-class task

Status: accepted (2026-09-13)

## Context

M20 made a conversation and a goal first-class above a task, gave every worker a handoff, and bound
native sessions to the envelope they were created under (ADR [0018](0018-session-execution-envelopes.md)).
The read path got all of it. The write path kept the shape it had in M11, and real dogfood finally
showed what that costs — a harmless DIRECT documentation edit ended `BLOCKED` with:

- no native session created, and none resumed: the write pipeline never called the resolver;
- no goal and no conversation on the task: `goal_id` was null and no turn was recorded, so the write
  did not appear in the goal's history at all;
- no route on the task: `/status` said "no route recorded" about a task whose own receipt named
  primary and reviewer;
- a reviewer called by default for a T2/low document edit, which then returned
  `CHANGES_REQUESTED` about an **empty** diff because the worker had changed nothing;
- `result = none · 0 bytes`, with the worker's own words nowhere: "it refused" and "it did nothing"
  were indistinguishable in the record;
- `write=blocked` in preflight (an untracked `AGENTS.md` makes the source "dirty") beside a write that
  then ran, because preflight measures the worktree policy's precondition and nothing gates on it.

Each of those is the same mistake in a different place: the write path was a separate pipeline rather
than the same task machinery with a different boundary.

## Decision

**A write is a task like any other. The execution policy is what differs.**

1. **The write resolves a native session, through the same resolver and the same envelope rules.**
   `WriteDogfoodRunner` takes the `NativeSessionResolver` the read path takes, calls it with
   `intent: "write"`, writes the session flags into the invocation, records `session.invocation`, and
   runs the turn in the session it was given. READ→WRITE therefore produces a fresh write session
   (an unrecorded or read envelope is never resumed for a write) and WRITE→WRITE resumes it, which is
   the M20 promise the write path was silently skipping.

2. **The task joins the goal.** `goalId` and `conversationId` are passed to `createTask`, so the write
   is a work unit of the goal and `linkTaskToGoal` has nothing to repair afterwards.

3. **The route is recorded.** The routed roles are written on the task, and the dashboard falls back
   to the roles the run's own provider events show answering — so `/status`, `tasks show` and the
   receipt describe the same run.

4. **Effort follows the budget.** A reviewer runs when the budget says `required` (T3+, high, critical)
   or when the operator asks (`--review`). A T0–T2 write is one worker by default; `--no-review` remains
   available, and the read path already worked this way.

5. **A worker that changes nothing gets a truthful no-change result.** The runner stops before review,
   records `write.no_changes` and `write.primary.reported`, and finalizes with the failure kind the
   taxonomy already has for it. No reviewer is asked to judge an empty diff, and the operator is told
   what the worker said rather than what a reviewer concluded about nothing.

6. **Preflight describes the policy it is measuring.** A clean checkout is a worktree precondition, so
   it is reported as one; it no longer makes `write=blocked` read as "BrainGate will not write".

## Consequences

- The DIRECT write path is one provider call for low-risk work, with continuity across turns and the
  same goal, history and receipts as a read. That is the product the M20 work was for.
- The reviewer is still reachable: T3+, high and critical risk require it, and `--review` asks for it
  on anything. What changed is that a documentation edit no longer pays for a second subscription by
  default.
- The write task's own record now distinguishes "changed nothing, and here is what the worker said"
  from "the change was reviewed and rejected", which were previously the same `BLOCKED`.
- An untracked file in the workspace no longer blocks a DIRECT write and is never attributed to the
  worker: the change report is a diff of the workspace before and after the run.
- Known gap, unchanged here: the provider cwd is recorded on the running transition rather than in a
  dedicated receipt field, and the *reviewer* for a DIRECT write still runs against a staged copy
  rather than the workspace — which is the next thing to reconcile.

## Alternatives considered

- **Keep the write pipeline separate and patch the missing pieces.** Rejected: this is four defects
  from one cause, and each patch would have been a fifth.
- **Make every write a worktree write again, since that path had a reviewer and a brief.** Rejected:
  it is the strict mode, and imposing it on ordinary interactive work is what ADR 0017 removed.
- **Call the reviewer but skip it when the diff is empty.** Rejected as the primary fix: it leaves the
  default costing a second subscription for a one-line documentation edit, and only hides the
  empty-diff case.
