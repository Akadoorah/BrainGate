# ADR 0010: A tool grant is earned per role, not decided per provider

Status: Proposed

## Context

Every shadow profile in `packages/shadow/src/profiles.ts` ends with a `guarantees` record:
`noShell`, `noNetworkTools`, `noMcp`, `isolatedUserConfig`, and so on. It is an honest record —
Grok's says `noShell: false` because Grok keeps its shell and the kernel, not a flag, is what
stops it — but it is a *description of what a profile happened to disable*, fixed per provider
and identical for every role that provider can fill.

That shape has a consequence the goal now runs into. A planner that could usefully search the
web, a coder that must run the project's test command, a scout that would benefit from the
provider's own subagents: none of these can be expressed. The record has no room for "for this
role, yes", so the answer is no everywhere, and BrainGate spends four subscriptions as four
readers.

Meanwhile the repository already contains the mechanism for saying yes safely, and has used it
twice. `codex-isolation.ts` and `grok-isolation.ts` each run a self-test that costs no model
call, read what the CLI actually enforced, and bind the result to the CLI version, the platform,
and a hash of the profile it was earned under — so a provider update invalidates the attestation
without anyone remembering to invalidate it. ADR 0006 established that pattern for config keys;
ADR 0009 used it to reopen Grok after re-measurement.

What is missing is not a safety mechanism. It is a vocabulary.

## Decision

Replace the fixed per-provider `guarantees` record with a **tool grant** negotiated per role.

1. BrainGate declares, per role, the capabilities that role needs: `read`, `edit`, `shell`,
   `web`, `mcp`, `subagents`. The declaration is provider-agnostic and belongs to routing
   policy, not to any adapter.
2. Each provider adapter maps a requested grant onto its own CLI's flags, and returns what it
   can actually enforce. An adapter that cannot honour a requested capability says so; it never
   silently returns less than was asked for.
3. Anything above `read` requires a current attestation bound to version, platform, and a hash
   of the granted policy — the existing `validCodexIsolationAttestation` /
   `validGrokIsolationAttestation` shape, generalised.
4. The effective grant is the intersection of what the role asked for, what the adapter proved,
   and what the operator has accepted. It is recorded on the plan and on the receipt, so the
   operator sees what a run was permitted *before* it runs and what it used afterwards.
5. `guarantees` remains in the emitted plan as the derived, honest description of the granted
   result. It stops being the place where capability is decided.

## Consequences

**What this buys.** The `coder` role becomes expressible for any provider that can prove a
bounded write, which is what lets more than one subscription carry the work. A role can be given
its provider's subagents without that being an all-or-nothing decision about the provider. And
the reason a capability was refused becomes legible: not "this provider is blocked" but "this
role asked for `shell`, and no current attestation proves this build scopes it".

**What it costs.** More attestations to earn, and more to invalidate. Every capability above
read is now a thing that can go stale, and staleness is the failure mode this repository has hit
most often. The binding to version and policy hash is what makes that safe, and it must not be
weakened for convenience.

**What must not follow.** A grant is a ceiling, never a promise about behaviour. The write path's
real protections stay exactly where ADR 0008 put them: the task worktree, the source
fingerprint, the diff guard, and the human at the merge. A generous grant does not soften any of
those, and a provider that misbehaves inside its grant still fails them.

**Migration.** The current profiles become the grants their roles already have — read for the
staged roles, the existing write permission set for Claude — so this change alone opens nothing.
It is the vocabulary that Milestones 16 and 17 need in order to open anything safely.

## Alternatives considered

**Keep per-provider guarantees and add role exceptions.** Cheaper, and it decays quickly: the
exceptions accumulate against a record that was never meant to carry them, and the question "what
may this run do" stops having one place to look.

**Grant capabilities without attestation, relying on the outcome checks.** ADR 0008 argues the
outcome checks are what actually protect the checkout, and that stands for writes to a worktree
BrainGate owns. It does not extend to `shell`, `web` or `mcp`, where the risk is what leaves the
machine rather than what lands in the diff — and there is no outcome check for that.
