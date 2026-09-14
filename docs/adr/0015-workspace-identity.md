# ADR 0015 — A workspace is a directory, and Git is metadata

Status: accepted (2026-09-20)

## Context

BrainGate's first identity model was built around Git. A project was one *checkout*, the checkout was
`git rev-parse --show-toplevel`, and `braingate init` refused any directory without a repository.

Three defects came out of that one decision.

**The directory the operator chose was not representable.** Launching in `repo/flutter_migration`
registered `repo`. Measured in real dogfood: registered `…/Lexar/Tabaq-ai-…`, launched from
`…/Downloads/Tabaq-ai-…/flutter_migration/tabaq_app_clean`. The execution path was widened to the
repository root, so the native CLI's `cwd` was a directory the operator was not working in.

**Two different directories could be one project.** Identity was a slug — a directory name resolving
to `<home>/projects/<slug>` — and nothing compared it with where the operator was standing. Two
clones of one repository both carried `project_id: flutter-migration` and wrote one ledger, one
goal store and one session thread. The operator launched from one clone and watched BrainGate reason
about the other.

**A directory without Git could not be used at all.** A plain directory, a documentation tree, a
scratch folder, a repository mid-`git init` — every one of them was refused by `init` with an error
in Git's vocabulary, after the operator had already answered two prompts. That is not a security
boundary; it is Git being the product model.

The correction that fixed the second defect made the first one worse, and that is what forced this
ADR. Comparing the registered path against the Git top level is stricter than comparing it against
the selected directory, and strictness in the wrong place refuses the ordinary case.

## Decision

**A workspace's identity is its canonical absolute path, and nothing else. Git is metadata a
workspace may have.**

```text
Project      — the operator's name for a body of work. Owns durable knowledge.
  └── Workspace  — a concrete local directory. Owns execution truth.
        └── Goal ──► Tasks ──► native workers, whose cwd is this directory
```

1. **A workspace is the directory the operator selected**, canonicalized. `gitRoot`, `branch`,
   `HEAD` and `remote` are recorded as evidence and decide nothing: not whether a workspace exists,
   not whether it may be registered, and not where a native CLI runs.

2. **Git is optional.** `braingate init` registers a plain directory. A repository is what the
   worktree-isolated write modes need, and the surfaces that need one say so where they need it,
   instead of the whole product refusing at the door.

3. **A registration is enforced against the selected directory.** The manifest names its workspace by
   absolute path. The execution path must be that workspace; a registration naming a *parent* of the
   selected directory is accepted, and the workspace stays the selected directory rather than being
   widened to the parent.

4. **Two workspaces of one project are two workspaces.** They may share a project id, a basename, a
   commit and a remote URL. Execution truth — changed files, tests run, native sessions, snapshots,
   fingerprints — belongs to the directory it happened in.

5. **A workspace id is derived from its path** (`sha256(canonicalPath)[0..16]`), so every process
   agrees on where a workspace's state lives without reading a registry first, and a directory can
   never acquire two identities.

6. **Git stays the isolation mechanism where isolation is Git's to give.** The snapshot and worktree
   policies are unchanged, and a workspace that is a subdirectory of a repository is still isolated
   by a worktree of that repository. What changes is that Git is no longer the *identity* of the
   thing being isolated.

## Consequences

- The provider's `cwd` is the workspace, so a native CLI sees the directory the operator chose and
  its own project-scoped files — `CLAUDE.md`, `.cursor/rules`, an `AGENTS.md` in that folder — are
  found where it would find them if the operator ran it directly. Preserving the native runtime
  (ADR 0014) requires this: a runtime whose `cwd` was silently moved is not the same runtime.

- The refusal for a mismatched registration survives from the earlier correction, with its
  comparison target changed. It is still refused in every direction, and still names both paths and
  both remedies.

- Existing manifests that recorded `repositories: [".."]` keep loading: the registry resolves a
  relative path against the manifest's own directory, and re-canonicalizes on read. New manifests
  are absolute.

- `Legacy mixed storage` — a `<home>/projects/<id>` written when a slug was the identity — is
  preserved read-only. It is not moved, not deleted and not assigned to a workspace on a guess,
  because the state in it belongs to a directory BrainGate can no longer identify.

- Deferred, and named so they are not mistaken for done: routing the ledger, goals and session
  thread to per-workspace storage; binding a goal to a workspace so a cross-workspace resume is
  fresh plus handoff by construction; and the DIRECT/NATIVE execution mode that makes a write in a
  non-repository workspace possible without a worktree. Each is its own slice.

## Alternatives considered

- **Keep Git the identity, and support subdirectories by registering a workspace as a *pair*
  (repository, subdirectory).** Rejected: it makes an optional capability structural, and the pair
  still cannot express "this directory, no repository".

- **Identify a workspace by its content or by its remote.** Rejected: two clones of one remote hold
  different uncommitted state and are the exact case that produced the original defect. A remote URL
  says two directories are related, never that they are the same.

- **Identify a workspace by a recorded UUID.** Rejected: it makes identity depend on a registry that
  can be lost, moved or copied with the directory. A path is derivable, comparable, and printable in
  a refusal message, which is what an operator needs from it.
