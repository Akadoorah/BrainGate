# ADR 0007: The visual role produces reviewable artifacts, not side effects

Status: Proposed

## Context

`ModelRole` has declared `"visual"` since the router was written, and `SkillRole` mirrors it.
Neither is reachable: nothing routes it, the model catalog has no capability field for it, and
no execution path exists. It is a name with no behaviour behind it.

The capability itself is real and was verified against the installed CLI rather than assumed.
Codex generates images: asked for one with `features.image_generation=true`, it produced a
1254×1254 PNG. Two properties of how it did so decide this design.

**The output does not land in the workspace.** The file was written to
`~/.codex/generated_images/<session>/<exec-id>.png` — inside the provider's own home, outside
the task worktree, outside the repository, and outside every boundary BrainGate enforces. The
sandbox correctly refused to let it write to the working directory, and the model reported the
path instead.

**Generation is a tool the model invokes, not a flag BrainGate passes.** There is no
`--generate-image` to drive and no declared output location to set. `-i/--image` attaches
images as *input*; the generation surface is internal. BrainGate can enable the feature and
observe the result, but it cannot instruct where the result goes.

Together these mean a naive visual path would produce files nobody registered, in a directory
no receipt mentions, surviving after the task that made them is gone. That is the opposite of
the property every other path holds: work lands in a task worktree, is reviewed, and reaches
the real checkout only by human merge.

A third constraint is already settled and does not reopen here. Provider profiles disable
`features.image_generation` for the reviewer, and that stays: a reviewer judges work, and a
reviewer that can also produce artifacts is no longer independent of what it is judging.

## Decision

The visual role is a first-class role that produces **artifacts**, collected into the task
worktree and reviewed like any other change.

- **Capability.** `capabilities.visual` joins `coder`, `reviewer` and `judge` in the model
  definition, scored by the operator like the rest. A model without it is not eligible, so
  routing a visual task to a text-only model fails closed instead of silently degrading.
- **Generation is a write.** A visual task takes the M11 write path: a task worktree, the
  existing sensitive-path and diff guards, no merge, human approval. Producing a file is a
  write whatever produced it.
- **Collection, not trust.** After the provider returns, BrainGate collects the artifacts it
  declared from the provider's output directory into the worktree, by exact path. Anything the
  provider produced that it did not declare is not collected. Nothing outside the declared set
  enters the repository.
- **Bounded.** Artifacts have a per-file size cap, a per-task count cap, and an allowlist of
  media types verified by content rather than extension. An artifact that fails any of these
  fails the task rather than being silently dropped, because a missing artifact that nobody was
  told about is the failure mode this ADR exists to prevent.
- **Recorded.** Each collected artifact is recorded in the receipt with its path, media type,
  byte size, content hash, and the model that produced it. `usageProvenance` labels artifact
  counts like every other measurement.
- **Reviewer stays blind to generation.** `features.image_generation` remains disabled in the
  reviewer profile. The reviewer sees the artifact as a file in the diff, which is what a human
  reviewer would see.

## Consequences

A generated image becomes an ordinary reviewable change: it appears in a worktree, in a diff,
in a receipt, with a hash, and reaches the repository only when a human merges it. The
guarantee that the source checkout is untouched holds without a special case.

The cost is that BrainGate depends on where a provider writes generated files, which is not a
documented contract and will move. That dependency is confined to the collection step, and the
Codex isolation self-test is the natural place to prove the output location before a visual task
is routed — the same shape as ADR 0006, where the installed CLI, not a hard-coded assumption,
is the authority.

Providers whose generation surface cannot be observed this way stay ineligible for the visual
role. That is the existing fail-closed posture and not a new restriction.

## Per-provider notes

These differ enough to shape the order of work, and were established from vendor documentation
and, for Codex, a direct run.

**OpenAI Codex — verified, collection required.** Generation works and produced a real PNG. The
file lands in the provider's own home with no way to redirect it, so the collection step above
exists for exactly this provider. It is first because the capability is proven and its
isolation already is too, through the sandbox self-test.

**xAI Grok Build — the cleaner contract, and one hazard the self-test must catch.** Now
installed (1.0.13) and inspected. It ships native `generate_image` and `generate_video` and
writes under `.grok/generated-media/` *unless a specific output path is requested*: a provider
that accepts an output path needs no collection step, because the artifact can be created inside
the task worktree rather than moved into it. It also runs its own sub-agents in per-branch
worktrees, the same shape as the write boundary here.

Its isolation surface is closer to Codex than to Antigravity, and has the piece Antigravity
lacks: `GROK_HOME` relocates the configuration home, so BrainGate can hand it a configuration it
controls. `--sandbox <PROFILE>` names a filesystem and network profile, defined in
`sandbox.toml` under either the home or the project, and `--permission-mode` accepts `plan`.

Two behaviours found by running it decide otherwise.

**A missing sandbox profile is a warning, not an error.** Asked for a profile that does not
exist, Grok prints `warning: sandbox could not be applied` and continues *without a sandbox*.

**It reads another tool's configuration.** `grok inspect` in a scratch directory, with a
project-local `sandbox.toml` defining a profile and `--permission-mode plan`, reports:

```
Permissions
└ Source: /Users/<user>/.claude/settings.local.json (settings)
Skills (124)
```

Its permissions came from Claude Code's settings file, and it loaded that installation's skills.
With the profile applied, it read a canary from outside the workspace. `GROK_HOME` does not
change this — the permission source is unchanged with it set — and setting it loses
authentication, exactly as with Antigravity. There is no flag to ignore ambient configuration.

So Grok has the surface Antigravity lacks and still cannot be scoped: what it may do is decided
by a file belonging to a different tool, which BrainGate neither owns nor can neutralise for one
call. This is a stronger reason to keep it closed than the one it replaces, and it is not a
statement about the sandbox mechanism, which may well work when it is the thing in force.

Execution stays fail-closed. What would open it is upstream: a way to run Grok against a
configuration BrainGate supplies without moving its credentials, and a sandbox that fails closed
when the profile it was given is absent.

**Google Antigravity — blocked by a conflict, not by effort.** Image generation is not native to
`agy`. It is reached through MCP servers or community scripts, and every BrainGate profile
denies MCP: `--disallowedTools mcp__*`, `--disable-builtin-mcps`, and `noMcp: true` in all three
guarantee sets. Enabling it would mean removing a security control that exists to keep a
provider from reaching tools BrainGate did not grant. That trade is a separate decision and is
not made here. The Antigravity desktop application does generate images, but it is not the
surface BrainGate drives.

The order follows from this: Codex, then Grok once installed and isolated, then Antigravity only
if the MCP boundary is deliberately revisited.

Until this is implemented, `"visual"` remains declared and unroutable, and this ADR is the
record of why it is not simply switched on.

## Amendment: BrainGate finds the file, because the provider cannot name it

The declaration protocol above asks the provider for the absolute path it wrote. Running it
against the real CLI showed that it cannot answer, and the reason is structural rather than a
matter of prompting: Codex names generated images itself, under
`$CODEX_HOME/generated_images/<session>/exec-<uuid>.png`, and the model is never told the path.

Asked to declare one, it replied "Created the PNG with a blue circle centred on a white
background." and the task failed with `VISUAL_NO_ARTIFACTS` — while three perfectly good PNGs,
one per attempt, sat on disk. The pass had been working the whole time; only the reporting was
impossible.

So BrainGate finds them. The set of files under that directory is recorded before the run and
compared after, which needs no cooperation from the model and cannot be talked into naming a
file that was never made. Two consequences follow:

- **The destination comes from the operator.** `--visual-to <path>` is required alongside
  `--visual`, because the destination is the half of the answer the provider genuinely does not
  have — it knows what it drew, not where the project keeps it. Several images from one request
  are suffixed rather than overwriting each other.
- **A declaration is still honoured when one is offered.** A provider that does know its own
  paths should be believed about them, and the block remains the documented way to say so.

Everything else in this ADR stands unchanged: the workspace is still read-only, generation still
needs no write access to the worktree, and every collected file still passes containment,
symlink, size and magic-byte checks before it reaches the reviewed diff.

Two further things the first real run exposed, both fixed:

- The executor refused the task worktree as "outside the registered project repositories". A
  write task's artifact pass runs against the worktree by definition, so the boundary now
  includes BrainGate's own task worktrees, which live under the project's private storage
  directory.
- `--visual --no-review` skipped the Codex sandbox self-test, because the attestation was only
  fetched when a reviewer was needed. The artifact pass runs under the same profile and needs
  the same proof.
