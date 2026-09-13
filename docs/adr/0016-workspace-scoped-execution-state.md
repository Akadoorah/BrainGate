# ADR 0016 — Execution state belongs to a workspace

Status: accepted (2026-09-20)

## Context

ADR [0015](0015-workspace-identity.md) made a workspace the directory the operator selected and made
Git metadata rather than identity. It did not move any state. Every store that describes *local
execution* still resolved to `<home>/projects/<projectId>` — the slug-era path — so the model said
one thing and the disk said another:

```text
<home>/projects/flutter-migration/
  tasks.sqlite      ← written by whichever workspace ran last
  goals.sqlite      ← one conversation, one active goal, shared by every clone
  dogfood.sqlite
  results/  session/  snapshots/  worktrees/
```

Two consequences, and both were live.

**Execution truth crossed workspaces.** A goal started in one directory was the active goal in
another; a task receipt recorded in one was history for the other; a provider session written in one
was offered for resume in the other. The session *record* had a `workspace` field and the resolver
refused a mismatch — but only when both paths were known, and nothing made a goal state which
directory it belonged to.

**The Goal could not say where it belonged.** `GoalRecord` carried a project id and nothing else, so
"which files is this goal about" was answered by the process's current directory at the moment of the
read. That is exactly the inference ADR 0015 removed from the attachment and left in the state layer.

## Decision

**Every store that describes local execution is scoped to one workspace. A goal states the workspace
it belongs to.**

1. **The handle decides the storage.** A store that writes execution state takes an
   `ExecutionProject` — a project handle whose `storageDir` is `<project>/workspaces/<workspaceId>` —
   rather than a `RegisteredProject`. The type difference is the point: the ledger, goals,
   conversations, the dogfood corpus, results and evidence, snapshots, worktrees and the session
   thread cannot be constructed for a project and then read another workspace's files.

2. **The workspace is the directory the manifest names**, not the directory the shell is in. Launching
   in `repo/src` reads and writes `repo`'s state — a project has the workspaces it was registered
   with and no others — while workers still run in the directory the operator launched from. A
   directory registered on its own (`braingate init` inside `repo/flutter_migration`) is its own
   workspace, with its own state, exactly as ADR 0015 requires.

3. **A goal names its workspace.** `goals.workspace_id` is written when the goal is created and
   compared on every read. A goal from another workspace is not the active goal here, is reported
   rather than hidden, and refuses by id with both workspaces named.

4. **A provider session is bound to project, workspace, goal, provider and model.** The workspace id
   is recorded beside the path, the lookup is scoped to the workspace's own store, and the resolver
   still refuses (`workspace-changed`) when a stored session names another workspace. Continuing the
   same logical work in another workspace is a *fresh native session plus a goal handoff*, never a
   native resume.

5. **Durable knowledge stays project-scoped.** Memory, preferences and the project identity remain at
   `<home>/projects/<projectId>`. `MemoryStore` and `ContextBuilder` refuse an execution handle, so
   project knowledge cannot be filed under whichever directory is current.

6. **State written before workspaces existed is `LEGACY_AMBIGUOUS_STATE`.** It is preserved where it
   is, never read, never migrated on a guess, never injected into a handoff and never resumed from.
   New workspaces start clean, and the operator is told once that the old state is there and why it is
   not in use.

## Layout

```text
<home>/projects/<projectId>/
  memory.sqlite                 durable project knowledge — unchanged location
  workspaces.json               the workspace registry: id → canonical path
  workspaces/<workspaceId>/
    tasks.sqlite                the ledger
    goals.sqlite                conversations, goals, turns, provider sessions
    dogfood.sqlite              execution observations and feedback
    execution.sqlite            worktree records
    results/<taskId>/           task evidence about local files
    session/thread.json         the expiring session thread
    snapshots/                  project copies taken for read tasks
    worktrees/                  isolated worktrees
    write-schemas/              per-task response schemas
  tasks.sqlite, goals.sqlite, … legacy, preserved read-only, never opened
```

The legacy paths and the new ones do not collide, so the migration is "start using the new
directory". Nothing is copied, moved or rewritten.

## Consequences

- Two workspaces of one project no longer share unfinished execution state. Native continuity stays
  provider-, model- **and workspace**-bound, which is what makes `/use` safe to use across a project
  with more than one directory.
- `braingate tasks list`, `/goal`, `/worker` and reconciliation read *this* workspace's state. A
  workspace with history shows it; a workspace without says so rather than showing another's.
- Legacy installations look empty until new work is done. That is the intended reading of state whose
  workspace cannot be identified, and the CLI says so instead of leaving the operator to guess.
- Deferred, and deliberately: the DIRECT/NATIVE execution mode that makes a write in a
  non-repository workspace possible without a worktree (ADR [0014](0014-native-runtime-preservation.md)
  classifies the restriction; this ADR does not change execution), an explicit import tool for legacy
  state, and mapping a subdirectory workspace *into* a task worktree rather than running the worker at
  the worktree root. `repositoryPath` remains the Git isolation unit for worktree writes.

## Alternatives considered

- **Move memory to `<projectId>/project/memory.sqlite` for symmetry.** Rejected: it would relocate
  durable knowledge that is already in the right place, and a path change is how a project's memory
  silently disappears.
- **Keep one store per project and add a workspace column to every table.** Rejected: it leaves every
  query one forgotten `WHERE` away from crossing workspaces, and the isolation would rest on each
  call site remembering rather than on the handle it was given.
- **Identify the workspace from the current directory at read time.** Rejected for the reason ADR 0015
  gives: identity is a decision recorded at registration, not a property of where a process happens
  to be.
