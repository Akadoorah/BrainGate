# Safe execution boundaries

BrainGate distinguishes **change isolation** from **process isolation**.

A Git worktree prevents normal task edits from landing in the developer's original checkout, but it does not stop a malicious or confused process from opening an absolute path elsewhere on the machine. Therefore BrainGate must never claim that a worktree alone is a security sandbox.

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

## Next security gate

Provider write execution in Milestone 6 must supply an isolation backend or a separately verified provider-native permission model before `worktree-write` can actually spawn a provider process.
