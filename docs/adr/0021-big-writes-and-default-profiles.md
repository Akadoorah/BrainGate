# ADR 0021 — Big writes are worktree + reviewer; default model profiles are a starting point the operator owns

Status: accepted (2026-09-19) — the default-profiles half. The big-writes half is drafted below and
is **not accepted yet**; it is decided and recorded when M23 Phase B lands.

## Context

Two decisions with one thing in common: both are places where BrainGate refused to act, and the
refusal turned out to cost the operator more than the thing it was protecting them from.

**Model scores.** BrainGate has never invented a capability score, a model id, a context limit or a
quota pool. That rule is right, and it comes from a real failure mode: a number BrainGate made up,
presented beside numbers the operator measured, decides which subscription gets spent. What the rule
did *not* anticipate is the first run. Nothing routes without a catalogue; a catalogue is a JSON
definition per model; and nobody can write one before they have used the thing. `docs/DOGFOOD.md`
spent four sections on it. The honest reading is that the refusal protected an operator who already
had a catalogue and stopped the one who did not — and BrainGate had exactly one operator.

**Big writes.** `assertM11Scope` refuses T3/T4 and high/critical-risk writes outright
(`packages/write/src/write-runner.ts`). That was correct when every write was a worktree write with
no reviewer guarantee. It is no longer the only option: ADR [0017](0017-direct-execution.md) made
DIRECT ordinary for small work, ADR [0005](0005-budget-governor.md) already requires a reviewer where
the budget says so, and the worktree path with `worktree-diff-review` exists and works. A refusal
now means "do it by hand in the CLI you already have", which is the outcome BrainGate exists to
improve on.

## Decision — default model profiles (accepted)

**BrainGate ships starting capability profiles for the model families the installed CLIs expose, it
adopts them only when the operator says so, it labels every entry it wrote, and it never overwrites
an entry the operator scored.**

- `packages/operator/src/default-model-profiles.ts` holds one row per family —
  `{ providerId, match, family, profile }` — with the roles the family is chosen for by default, a
  speed class, a context capacity, a write flag, a reasoning score and a quota pool. The numbers are
  taken from the only scored catalogue this project has ever had, the operator's own, read
  2026-09-19; they are not measurements of the models.
- The **ids** are measured on the installed CLIs and dated in the file's comment. On 2026-09-19:
  `grok models` (grok 1.0.30) lists `grok-4.6`, `grok-4.5`; `agy models` (agy 1.2.7) lists the
  `gemini-3.8/3.7/3.6-flash-*` and `gemini-3.1-pro-*` tiers and, served through Antigravity,
  `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`; `claude` (2.1.278) has no
  `models` subcommand at all — `claude models` is read as a prompt — and `codex models`
  (codex-cli 0.153.4) exits with "Error: stdin is not a terminal".
- A CLI that publishes no list gets `KNOWN_MODELS_WITHOUT_LISTING`: the ids BrainGate offers for it,
  adopted as **assumed** and labelled so. A stale assumed id fails at the provider with the
  provider's own error, and `braingate models remove` is one command.
- A model **another provider serves** matches nothing. `claude-sonnet-4-6` under `google` is the
  Antigravity subscription, not the Anthropic one, and filing it under `claude-subscription` would
  put two bills in one bucket. Such ids are imported unscored, named, and left unrouted.
- Every adopted entry carries `source: "braingate-default"` or `"braingate-assumed"` in the
  catalogue. An entry with no `source` is the operator's — which is what every catalogue written
  before this ADR is. `models profile` and `/models` report which scores nobody has decided yet.
- `adoptDiscoveredModels` never touches a `configured: true` entry. `/setup` is therefore safe to
  rerun, and rerunning it reports those entries as `kept (your scores)`.
- The first-run wizard (`apps/cli/src/setup-wizard.ts`) asks at most four questions — register,
  adopt, accept Antigravity where an acceptance would grant something, reviewer on every write — and
  prints everything else it assumed. It records the ADR [0008](0008-operator-accepted-providers.md)
  acceptance through `ProviderAcceptanceStore` and nothing else about a provider; it only *describes*
  Antigravity's own settings (ADR [0020](0020-antigravity-direct-is-read-from-its-own-settings.md));
  it writes no quota state and reads none (ADR [0012](0012-quota-state-is-native-only.md)).
- Session preferences (`policy`, `reviewAlways`) are workspace-scoped execution state
  (ADR [0016](0016-workspace-scoped-execution-state.md)), kept beside the thread under the
  workspace's storage — never in `.brain/project.json`, which is identity
  (ADR [0015](0015-workspace-identity.md)) and is refused on rewrite.

### Consequences

- A first run is four questions and a working catalogue, on a machine with nothing configured.
- A number BrainGate invented is never indistinguishable from one the operator measured: the
  catalogue carries the difference, and two surfaces print it.
- The starting scores go stale the way every provider fact does. They are never re-applied over an
  operator's entry, so staleness costs a default, not their tuning.
- `braingate init` on a terminal with no flags is now the wizard. With any flag it is the plain,
  non-interactive command it always was, and `--adopt-models` / `--accept <provider>` do the
  wizard's work without asking.

## Decision — big writes (Phase B; **not yet accepted**)

*This section is a placeholder with the intended shape, so that the part already implemented can be
read against what it is going to amend. Nothing here is in force, and no code implements it yet.*

The intent recorded in the M23 plan is that a T3/T4 or high/critical-risk write is no longer refused
outright but **escalated**: it runs in an isolated worktree with a mandatory reviewer from another
provider, and never DIRECT. `assertM11Scope` becomes `bigWrite(classification)`, the plan gains
`allowEscalation`, `escalated: { from, reason }` and `reviewRequired`, the reviewer route for a big
write is cross-provider or the task does not run, and a `--policy direct` big write exits non-zero
with the remedy rather than silently running in the workspace.

When that lands, this ADR will also record how it amends ADR 0017 (DIRECT stays the ordinary policy
for T0–T2 low/medium), ADR [0019](0019-a-write-is-a-first-class-task.md) (escalation is recorded on
the write task's plan and receipt) and ADR 0005 (a big write's reviewer is cross-provider or the
task does not run).
