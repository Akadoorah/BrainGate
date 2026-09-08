# ADR 0008: A provider BrainGate cannot isolate may still be used, if the operator says so

Status: Proposed

## Context

Antigravity and Grok are blocked because neither can be scoped per invocation. Antigravity keeps
configuration and credentials under the same `HOME`, so isolating one loses the other. Grok
resolves its permissions from `~/.claude/settings.local.json` — a different tool's file — and
`GROK_HOME` neither moves that nor survives authentication. Both were established by running
them, and both stand.

What does not follow is that BrainGate should refuse to use them.

The isolation requirement exists for a specific reason: a provider running against the real
checkout with tools the operator did not grant. That reason applies to `workspaceMode: "project"`.
It does not apply to `staged-clean`, which BrainGate already uses for the Codex reviewer: a fresh
temporary directory the provider is pointed at, containing only what BrainGate put there. A
provider working there cannot leak a repository it was never shown.

The write path is stronger still, and this is easy to get backwards. Its guarantees are not that
the provider behaves: they are that work happens in a task worktree, that the source checkout is
fingerprinted before and after, that every changed path passes the diff guard, and that no merge
happens without a human. Those are BrainGate-side checks on the *outcome*. A provider that
misbehaves fails them whether or not it was isolated going in.

And the operator already runs these CLIs by hand, with full access, every day. BrainGate
refusing to invoke them removes nothing from their exposure; it only makes BrainGate less useful
while the same work happens outside it. A tool that is fail-closed against a risk its user has
already accepted elsewhere is not protecting them — it is declining to help.

One residual is real and cannot be argued away: a provider whose permissions BrainGate cannot
scope may read or write **outside the project** — elsewhere on the machine. No BrainGate guard
sees that. It is the same exposure as running the CLI manually, but it is not zero, and the
operator must be the one to accept it.

## Decision

Provider eligibility becomes per role, and a provider BrainGate cannot isolate becomes usable
for any role once the operator has accepted the residual risk explicitly.

- **Roles, not providers.** A profile declares which roles it permits rather than a single
  enabled flag. A provider that cannot be isolated is still eligible for roles that never touch
  the real checkout — planning, review of staged content, artifact generation — because those
  run `staged-clean`.
- **Project access needs acceptance.** Roles that run `workspaceMode: "project"`, and the write
  path, require a recorded operator acceptance for that provider. Without it they remain closed.
- **Acceptance is explicit, per provider, and revocable.** It follows the shape already used for
  Copilot's subscription attestation: something BrainGate cannot prove, asserted by the operator,
  recorded with a timestamp, and refused when stale. It is never inferred from the provider being
  installed, authenticated, or previously used.
- **Acceptance is visible.** `braingate doctor` names every provider running on operator
  acceptance rather than proven isolation, so the state is legible rather than remembered.
- **Nothing else is relaxed.** The worktree boundary, the source-checkout fingerprint, the diff
  guard, the sensitive-path rules, the artifact collector, and human approval all apply
  unchanged. Acceptance widens which providers may be asked; it does not widen what any provider
  may leave behind.
- **The default stays closed.** A fresh installation routes to nothing that has not proven its
  isolation. Acceptance is a decision the operator makes, not a default they discover.

## Consequences

The operator can use the subscriptions they pay for. Planning can go to the strongest model
available in any of them, code can be written by a cheaper one, and review can come from a
different vendor — which is the point of the project and is currently reachable across two
providers out of five.

The cost is honest rather than hidden: for an accepted provider, BrainGate's guarantee narrows
from "this provider was proven unable to reach outside its workspace" to "whatever it did to the
project is verified, and what it may have done elsewhere is unchecked". The README says so
plainly, in the section where a reader decides whether to accept.

This does not close ADR 0006's or ADR 0007's provider notes: those record what would have to
change upstream for isolation to be provable, and that remains the better outcome. Acceptance is
the operator's route around a limitation in the provider, not a decision that the limitation
stopped mattering.
