# ADR 0017 — DIRECT execution: role, policy, and the native harness

Status: accepted (2026-09-20); amended by ADR [0020](0020-antigravity-direct-is-read-from-its-own-settings.md) (2026-09-19: Antigravity runs DIRECT when its own settings allow headless reads) and by M22 (the policy gates every role, and the route chooses the worker)

## Context

ADR [0014](0014-native-runtime-preservation.md) settled the *principle*: the native runtime is the
default interactive execution mechanism, and BrainGate coordinates it. Every restriction that
principle contradicts was classified there as `legacy` and left standing, because removing one is not
a policy change — it is a change to what BrainGate asks a CLI to do, and each has to be re-measured
against the installed build.

The execution *model* was never changed at all. Two answers were hard-coded: a read ran against a
snapshot, a write ran in a Git worktree. Both are good answers to "run this where it cannot do harm",
and both were being given to questions nobody had asked:

- A one-line read of `config.yml` copied the project first.
- A one-line fix landed in a worktree the operator then had to review, approve and merge — and the
  worktree, not the workspace, was the only place the change existed until they did.
- A workspace a snapshot cannot represent — an untracked nested repository, which real projects
  have — could not be read at all, because the strict read posture refused to represent it.
- Switching an executing role to Grok or Codex required a sandbox attestation earned against a staged
  copy, so the *staged copy* was the thing being preserved rather than the runtime.

The result was a control plane that could not do what the CLIs do: `cd /workspace && claude` edits
files in `/workspace` and leaves them there, and BrainGate would not.

## Decision

**Three things, kept separate.**

```text
ROLE             = purpose        (plan, execute, review, judge)
EXECUTION POLICY = boundary       (direct, read-only, worktree, snapshot, unattended)
NATIVE CLI       = harness        (its tools, shell, subagents, MCP servers, permissions)
```

1. **DIRECT is the ordinary interactive policy.** The native CLI runs in the selected workspace,
   with the workspace as its `cwd`. No worktree is created, no snapshot is taken, no commit is made,
   and nothing is merged. Successive workers share the filesystem: the second reads the first's
   changes from the same directory, because that is where they are.

2. **The strict modes remain, and are chosen.** `worktree` and `snapshot` are unchanged in what they
   guarantee, and they are selected explicitly (`/policy worktree`, `--policy snapshot`, or a policy
   an unattended workflow requires). A workspace a snapshot cannot represent may still make
   `snapshot` refuse — that is now a fact about the choice, never about the workspace.

3. **Intent decides what is wanted; policy decides where it may happen.** The classifier still
   separates a read request from a write request, and a request that says "do not modify anything" is
   read-only whatever the policy is. Intent can only ever *narrow* the boundary: DIRECT plus a
   read-only intent is a run held to having changed nothing, verified afterwards.

4. **DIRECT keeps the runtime's harness.** For the runtime whose invocation can honour it today
   (Claude Code), the plan drops exactly the three restrictions ADR 0014 classifies as legacy —
   BrainGate's tool allowlist, the universal MCP refusal, and BrainGate-declared subagents — and
   passes the CLI's own `--permission-mode` instead. Nothing is *granted* by this: a headless run
   still refuses what the CLI would have prompted for, and it says so as the CLI's decision rather
   than as a BrainGate invention. The guarantees published on the plan are updated to match, so a
   plan can no longer claim `noMcp` while loading the operator's servers.

5. **What changes the workspace is observed, not asserted.** A DIRECT run fingerprints the workspace
   before and after through a guard that works with or without Git, reports the files that changed,
   and claims no verification it did not perform. A read-only run uses the same guard to *refuse* —
   the workspace it was told not to touch must be byte-identical afterwards.

6. **Git is observed, never driven.** HEAD, branch, status and diff may be read for the record. No
   policy checks out a branch, resets, cleans, stashes or commits. A commit happens only when the
   operator asks for one, and BrainGate does not yet offer that, so it does not happen.

7. **A worker may leave uncommitted changes.** That is the normal outcome of a DIRECT write, and the
   receipt says so: what changed, who changed it, in which workspace, under which policy, and that
   nothing was committed.

## What is not preserved yet

Reported rather than faked, because a preserved capability that is not preserved is worse than a
missing one:

- **Grok, Codex and Antigravity cannot run DIRECT.** *(Superseded.)* Grok and Codex gained measured
  DIRECT invocations in M21. Antigravity's is gated on the operator's own settings allowing headless
  reads — ADR [0020](0020-antigravity-direct-is-read-from-its-own-settings.md) — because its print
  mode auto-denies every tool that would have prompted and takes no allow-list per invocation. On a
  machine without that rule the plan still refuses `nativeHarness` for it, and the refusal names the
  rule. Their staged and snapshot postures are unchanged.
- **The headless prompt.** In print mode there is nobody to answer a permission prompt, so a tool the
  runtime would ask about is refused by the runtime. That is the CLI's own model applied faithfully —
  and it is why a DIRECT write edits files but does not run a test suite unless the operator's own
  configuration allows it.
- **`--restricted` and `--safe-mode` are still passed.** They bound the run to the workspace without
  replacing the runtime's harness, and removing them is a separate question that needs a
  re-measurement rather than an opinion.
- **A DIRECT write still routes to Claude only.** *(Superseded.)* Grok and Codex write DIRECT since
  M21, Antigravity since ADR 0020 under the same settings gate, each with its own edit posture
  (`workspace-write`, `acceptEdits`, `--mode accept-edits`). The router still excludes a provider
  for the policy it cannot run rather than failing later.

## Consequences

- The ordinary loop is now the one the product promised: launch in a workspace, ask for a change, see
  it in the files, switch workers, and have the next one read what the last one wrote.
- Nothing about the strict modes was weakened. A read-only task's guarantee is the same; a worktree
  write's isolation is the same; the nested-repository refusal now applies only where it belongs.
- Uncommitted work accumulates in the workspace, which is what "operate naturally" means and what the
  operator's own `git status` is for. BrainGate reports it and never tidies it.
- A receipt can now be audited for the boundary it ran under: policy, workspace id and path, provider
  `cwd`, changed files, session kind, and the operation's intent.

## Alternatives considered

- **Keep the worktree as the default and make DIRECT an opt-in flag.** Rejected: the flag would be
  the product, and the default would keep answering a question nobody asked.
- **Make DIRECT the only mode and delete the strict ones.** Rejected: an unattended run, a risky
  edit and a read of a project you do not want touched all need a boundary that is not "whatever the
  CLI felt like".
- **Let every provider run DIRECT immediately.** Rejected: each invocation would carry a boundary
  nobody measured, and the operator would have no way to tell which of them still held.
