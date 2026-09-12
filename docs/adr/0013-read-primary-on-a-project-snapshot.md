# ADR 0013 — Read-primary on a project snapshot

Status: accepted (Phase A, 2026-09-12)

## Context

The read-primary role could only run on Anthropic, because that is the one provider BrainGate points
at the operator's checkout. Codex and Grok are confined to a workspace BrainGate builds for them, and
that workspace held only the context a role was handed — never the project. So a quota refusal on the
Anthropic pool left the task with no eligible primary at all: truthful (`ROLE_NO_ELIGIBLE_FALLBACK`),
but not resilient.

Two ways out were available. Grant Codex or Grok the checkout, which would widen a security boundary
that ADR 0009 and ADR 0010 exist to keep narrow. Or copy the project into a workspace BrainGate
already owns, and point the provider at the copy. This ADR records the second.

## Decision

**Read-primary may run on a BrainGate-made snapshot of the project.** The provider's working directory
is the copy; the operator's checkout is never visible to it, and no role or profile gains access to it.

1. **One policy, written down.** A snapshot contains the tracked tree as it is on disk (dirty tracked
   files included), non-ignored untracked files, and in-project symlinks materialised as content. It
   excludes `.git`, `.brain`, git-ignored files, non-regular files, and every path the existing
   sensitive-path policy names. A snapshot that cannot be complete as defined by that policy — over a
   cap, an unresolvable or escaping symlink, an unreadable file — is **not created**; the preflight
   fails rather than handing a provider a project with a hole in it.
2. **One task, one state.** The source fingerprint is recorded *before the first provider call* and the
   copy is only ever taken of that state. If the project moved in between, the copy is refused
   (`SNAPSHOT_SOURCE_CHANGED_SINCE_TASK_START`) — a planner and the provider that answers must not have
   read different projects. One snapshot per task, reused by every failover attempt.
3. **One mode per candidate.** `project-checkout` for Anthropic, `staged-read-snapshot` for a
   snapshot-capable provider. The mode follows the *effective* candidate, so a failover switches it
   without anyone deciding to.
4. **A distinct scope of exposure, not a wider one.** A snapshot holds a *subset* of what the trusted
   primary can already read, and the provider that reads it has no write or shell tool on that path.
5. **A lifecycle.** Snapshots live under one canonical root inside the project's own storage, carry a
   lease naming the process that owns them, are released on every terminal path including a signal,
   and are swept when their owner is gone (pid dead, grace elapsed, task not runnable). The sweep never
   follows a symlink, never leaves the root, and never deletes a directory whose metadata it cannot
   read.
6. **Existing attestations carry over only where the policy is identical.** The snapshot scope reuses
   the Codex and Grok sandbox profiles, and a test compares every security-relevant field between a
   staged role and a snapshot primary — argv, environment, tool grants — so a future divergence fails
   the suite instead of inheriting a proof.

## Consequences

- A quota refusal or an active refusal backoff on the Anthropic pool can now move read-primary work to
  another subscription, with the provider reading a copy rather than the checkout.
- Google/Antigravity stays out: it has no per-invocation scope, so it cannot be confined to a copy.
- xAI/Grok read-primary is **not eligible** as of 2026-09-12 (grok 1.0.24, darwin): its sandbox grants
  write access to its own working directory, so a project copy it can rewrite is not a read-only
  workspace. The snapshot-read profile and the isolated-home posture are implemented and gated behind
  their own proof, so a release that can deny those writes makes the mode earnable without a redesign.
- Write-primary failover remains disabled; a worktree may already hold partial work, and the snapshot
  mechanism deliberately does not create a write path.
- The snapshot is a cost and a copy: large projects may exceed the caps and cannot use it at all, and
  an active snapshot occupies disk until the task ends.
- A snapshot is temporary by design. The permanent evidence is the manifest identity recorded in the
  task's own event stream, so what the provider was given stays auditable after the copy is gone.
