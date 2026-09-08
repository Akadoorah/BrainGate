# ADR 0009: Grok's isolation is provable now, so BrainGate proves it instead of refusing

Status: Accepted

## Context

ADR 0008 was written to give the operator a way around two providers BrainGate could not
isolate. For Grok, the two findings behind that were:

1. `grok inspect` reported its permissions source as `~/.claude/settings.local.json` — a
   different tool's file, which BrainGate neither owns nor can neutralise for one call — and
   `GROK_HOME` neither moved that source nor survived authentication.
2. A sandbox profile that could not be found produced a warning, and the run continued
   unsandboxed. `--sandbox` was a request, not a guarantee.

Both were true when they were measured. Neither is true of grok 1.0.13, and both were
re-measured rather than assumed:

- `GROK_HOME` now locates configuration *and* credentials. Running with an isolated `HOME` and
  the operator's real `GROK_HOME`, `grok inspect` reports `Permissions: (none), 0 loaded` and
  `grok models` still reports a signed-in account. The other tool's settings file is not
  merely ignored; from that process's point of view it does not exist. Loaded skills drop from
  124 (user) to 24 (bundled) in the same run.
- A *custom* sandbox profile that cannot be applied now aborts: "Refusing to start with its
  protections missing." A built-in profile still only warns, which is why BrainGate defines its
  own rather than passing `--sandbox strict`.
- A custom profile may be defined in `.grok/sandbox.toml` inside the working directory. BrainGate
  creates the staged workspace, so it can write that file into a directory it owns, for one run,
  without ever editing the operator's Grok configuration.
- What the profile enforces is kernel-level — Seatbelt on macOS, Landlock on Linux — and covers
  the shell and subagents, not only the read tool. Under `extends = "strict"`, a read outside the
  workspace is refused, and `cat` of the same path from the bash tool fails with `Operation not
  permitted`.
- Grok records every applied profile to `$GROK_HOME/sandbox-events.jsonl`, with the path sets in
  force, before it validates the requested model.

That last point is what makes this cheap. A probe naming a model that cannot exist aborts at
model validation — after the kernel policy is applied and logged, and before any completion. The
self-test therefore costs nothing and still reads ground truth.

## Decision

Grok is enabled for staged roles, on a per-run sandbox self-test, and closed for everything else.

- **A staged Grok run is confined by the kernel, not by a prompt.** BrainGate writes
  `.grok/sandbox.toml` into the staged workspace defining `braingate-staged`
  (`extends = "strict"`, `restrict_network = true`) and passes `--sandbox braingate-staged`.
  Custom profiles fail closed, so a profile that does not apply stops the run.
- **`HOME` is isolated; `GROK_HOME` is the operator's.** The same shape already used for Codex.
  Authentication survives; another tool's permission file does not reach the run.
- **The attestation is read from Grok's own event log, not from BrainGate's config file.** Grok
  resolves a same-named profile in the operator's `sandbox.toml` in preference to the project
  one, silently. Hashing the file BrainGate wrote would still match while a different policy was
  in force, so the self-test checks the roots actually granted, and refuses any grant it did not
  define — which is exactly how a shadowing `extends = "devbox"` shows up.
- **The attestation is bound to version, platform and profile, and expires in 24 hours.** As
  ADR 0006 does for Codex. An attestation earned under another build says nothing about this one.
- **Staged roles only.** Planner, reviewer and judge run in a workspace holding nothing but the
  request. A role that must read the checkout is refused, because the confinement that makes the
  staged roles safe is the same fact that makes such a role impossible.
- **What BrainGate cannot turn off, it reports or refuses.** `GROK_HOME` is the operator's real
  Grok home, so what that home configures is inside the sandbox with the run. MCP servers are
  refused outright — an MCP server is an arbitrary process with its own network access and there
  is no per-invocation way to disable one. Hooks and marketplace plugins are named by
  `braingate doctor` rather than left for the operator to assume are absent.
- **Network restriction is recorded per platform, never claimed uniformly.** `restrict_network`
  blocks child-process network on Linux via seccomp and is a documented no-op on macOS. The
  attestation says which, so no receipt claims a guarantee the kernel did not make.
- **Below 1.0.13, Grok stays closed.** That is the release where a missing custom profile stops
  being a warning.

## Consequences

The strongest thing this changes is not that Grok works: it is that a provider moved from "the
operator accepts a risk" to "BrainGate proves there is none of that kind", by re-measuring
instead of trusting a note. ADR 0008's acceptance route stays for Antigravity, which still keeps
settings and credentials under one `HOME` and offers no second variable to separate them.

The residual is narrower and stated rather than implied: a staged Grok run is confined to its
workspace and the system, but it runs under the operator's Grok home, so hooks and plugins
configured there load with it, and on macOS a child process is not network-blocked. Neither can
reach the project. Both are visible in `braingate doctor`.

This also closes ADR 0006's note about Grok. The upstream change it was waiting for happened.
