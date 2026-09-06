# @braingate/execution

Local execution primitives for registered projects.

- WorktreeGuard creates task branches/worktrees only for repositories owned by the active project and records an append-only lifecycle.
- SafeCommandRunner accepts structured argv (never shell strings), permits only restricted Git inspection in read-only mode, and only exact declared verification commands in verify mode.
- `worktree-write` intentionally **refuses to execute an untrusted process** until a real isolation backend is attached. A Git worktree is a change-isolation mechanism, not a complete filesystem sandbox.
