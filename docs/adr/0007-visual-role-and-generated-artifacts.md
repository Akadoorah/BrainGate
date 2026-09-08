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

Until this is implemented, `"visual"` remains declared and unroutable, and this ADR is the
record of why it is not simply switched on.
