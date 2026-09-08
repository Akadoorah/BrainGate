# ADR 0006: Provider control keys are validated against the installed CLI, not assumed

Status: Proposed

## Context

BrainGate hardens the Codex reviewer by passing an explicit deny list of provider feature
keys (`CODEX_REVIEW_DISABLED_FEATURES`) as `-c features.<name>=false` overrides, under
`--strict-config`. The list was written against the Codex build available at the time.

Provider CLIs rename and remove configuration keys between releases. Codex 0.153.4 no longer
recognises `features.worktrees`. Because `--strict-config` rejects any unknown key, the whole
reviewer invocation failed with exit 1 and surfaced as `SHADOW_PROVIDER_FAILED`, with no
indication that the cause was a stale control key rather than an isolation failure.

Two properties are in tension:

1. A control key BrainGate believes it is setting must actually be set. Silently dropping an
   unrecognised key would weaken the reviewer sandbox without any signal.
2. A control key that no longer exists upstream is not a weakening — the feature it disabled
   is gone — but it currently breaks every reviewer run.

Removing the key by hand, as was done for `features.worktrees`, resolves the breakage but
leaves the same failure waiting for the next Codex release, and gives the reader no way to
tell an intentional removal from an accidental one.

## Decision

The Codex isolation self-test becomes the authority on which control keys the installed CLI
accepts, and the attestation records them.

- The self-test probes the installed Codex with the full deny list and partitions it into
  keys the build accepts and keys it rejects as unknown.
- Rejected keys are recorded in the attestation alongside the version, platform, and profile
  hash. The profile hash covers the accepted set, so a change in what the CLI honours
  invalidates the attestation and forces a fresh self-test.
- A key that the CLI rejects as *unknown* does not block the reviewer: the feature is absent
  from that build, so there is nothing to disable.
- A key that the CLI accepts but that fails to take effect during the self-test's filesystem
  and network probes remains fail-closed, exactly as today.
- `braingate doctor` reports dropped keys explicitly, so a control disappearing upstream is
  visible rather than silent.

`CODEX_REVIEW_DISABLED_FEATURES` stays the declared intent and is never edited to work around
a breakage; reconciliation with the installed build happens at self-test time.

## Consequences

The reviewer survives upstream key renames without a code change, and without any path that
quietly narrows the sandbox — an unknown key is provably absent, and a present-but-ineffective
control still fails closed.

The cost is that the attestation becomes build-specific in one more dimension, so a Codex
upgrade forces a fresh self-test. That is already true of the version and profile hash.

Until this is implemented, `features.worktrees` remains removed from the declared list as a
targeted fix for Codex 0.153.4, and that removal is the open control regression this ADR
closes.
