# Safe execution

## Execution policy

Where a worker runs is chosen, and it is separate from what the request is about: the classifier
decides whether the operator wants a read or a change, the policy decides where that may happen.
Intent can only narrow the boundary, never widen it.

| Policy | Where the worker runs | Writes | Git |
|---|---|---|---|
| `direct` (default) | the selected workspace itself | allowed | observed only |
| `read-only` | the selected workspace | refused, and verified afterwards | observed only |
| `worktree` | an isolated task worktree | proposed, never applied | required |
| `snapshot` | an immutable copy taken for the run | refused | required |
| `unattended` | the selected workspace, nobody present | allowed, under BrainGate's own bounds | observed only |

DIRECT is what ordinary interactive work means: the native CLI runs in the workspace you selected,
its changes are there when it finishes, and the next worker reads the same files. Nothing is
committed, merged, reset or cleaned, and uncommitted changes are a normal outcome rather than a
failure. The strict modes are one `/policy` away and are never chosen for you. See ADR
[0017](adr/0017-direct-execution.md).

## Boundaries

BrainGate distinguishes **change isolation** from **process isolation**.

A Git worktree prevents normal task edits from landing in the developer's original checkout, but it does not stop a malicious or confused process from opening an absolute path elsewhere on the machine. Therefore BrainGate must never claim that a worktree alone is a security sandbox.

## A provider reading a copy of the project

A read-primary run on Codex or Grok does not read the checkout. BrainGate copies the project into a
workspace it owns and points the provider at that — see ADR 0013. Three consequences are worth stating
where the boundaries are described:

- **The file set is a decision, not "the project".** Tracked files as they are on disk, non-ignored
  untracked files, and in-project symlinks taken as content. `.git` is not copied (the copy is not a
  repository), BrainGate's own `.brain` state is not copied (it is not project content), git-ignored
  files are not copied, and neither is any path the sensitive-path policy names — `.env`, private keys,
  credential stores. So a snapshot can only ever hold *less* than the checkout the trusted primary
  reads.
- **A copy that would be incomplete is not made.** File, byte and file-count limits are refused rather
  than truncated; a symlink that leaves the project is refused rather than skipped. The run fails
  preflight and says why, because a provider answering about a project with a hole in it is worse than
  a task that did not start.
- **A provider that cannot deny writes does not get the mode.** Codex's read-only sandbox is probed by
  attempting the writes it must refuse — create, overwrite and delete inside the workspace, and create
  and overwrite in a stand-in checkout — and the mode is only eligible when the sandbox refuses all
  five. Grok is measured the other way: its applied `strict` profile lists the workspace under
  `read_only_paths` *and* under `read_write_paths` (the same directory through macOS's `/private`
  alias), so it grants write access to its own working directory. Measured 2026-09-12 against
  `grok 1.0.24` on darwin, and for that reason **xAI read-primary is not eligible**; `braingate doctor`
  reports the grants it saw rather than a verdict. An older finding would be re-measured before being
  relied on again: these CLIs ship weekly.
- **The copy lives and dies with the task.** It is created once per task from the state the task
  started from, released on success, failure and interrupt, and swept afterwards if the process that
  owned it is gone. The permanent record keeps the manifest hash, the file and byte counts, the policy
  version and the source fingerprint, so what the provider was given stays auditable after the copy is
  deleted.

## Profiles

- `read-only`: currently restricted to non-mutating Git inspection commands inside a registered repository.
- `verify`: exact project-declared verification commands inside a BrainGate-created worktree.
- `worktree-write`: target authorization exists, but untrusted process execution is blocked until an isolation backend is attached in the provider execution layer.

There is deliberately no `direct-write`, `deploy`, `production`, or `merge` profile.

## Secrets

Sensitive path patterns are denied before file reads. Captured process output is redacted before it can enter an audit event. Child environments are constructed from an allowlist; known direct-API billing variables are stripped regardless of caller input.

These controls are defense in depth and do not replace a provider/OS sandbox.

## Skills

Skills are physically scoped under either `global/<skill_id>` or `projects/<project_id>/<skill_id>`. A skill cannot broaden the execution profile. High/critical-risk skills cannot auto-load.

## Where the boundary comes from now

Write execution shipped in M11 and widened to more than one provider in M16; the isolation backend
this section used to wait for is the worktree plus the provider's own proven sandbox. What changed in
M20.2 is the *default posture*, and it is worth stating precisely because it is easy to misread:

- **Interactive work runs the way the runtime runs.** The provider's own permission prompts remain the
  approval mechanism, exactly as when the operator starts the CLI themselves. BrainGate does not
  stand in front of them.
- **A boundary the operator asks for is applied.** A read-only request is a read-only task; a write
  goes to a worktree the operator reviews and never lands in their checkout.
- **Unattended execution is constrained more.** Where nobody is present to approve a runtime action,
  BrainGate's own policy is what stands in for that approval.
- **The strict modes remain available** and are chosen, not assumed: project snapshots, isolated
  worktrees, and the Codex and Grok sandbox attestations proven per run.

The controls in this document — path denial, output redaction, the allowlisted child environment, and
the API-key stripping — are unaffected and remain in force. They are overlays on a preserved runtime,
not a replacement harness. ADR [0014](adr/0014-native-runtime-preservation.md) is the principle;
ADR [0010](adr/0010-tool-grants-are-earned-per-role.md) is still how a capability is earned.
