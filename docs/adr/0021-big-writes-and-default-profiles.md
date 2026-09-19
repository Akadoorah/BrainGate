# ADR 0021 — Big writes are worktree + reviewer; default model profiles are a starting point the operator owns

Status: accepted (2026-09-19). Both halves: default model profiles (M23 Phase A) and big writes
(M23 Phase B).

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

## Decision — big writes (accepted)

**A T3/T4 or high/critical-risk write is never refused for its size, never runs in the operator's
checkout, and never runs without a reviewer from another provider. Asked for DIRECT it escalates to
an isolated worktree, or — where the operator typed the policy themselves — it is refused for that
policy with both ways forward.**

- `assertM11Scope` is replaced by `bigWrite(classification): string | null`
  (`packages/write/src/write-runner.ts`), which answers *what this write needs* rather than *whether
  it may run*. The reason is the tier when the tier is what makes it big (`T3`, `T4`) and the risk
  word otherwise (`risk high`, `risk critical`), because a T2 change to auth or payments is a big
  write for a reason its tier does not carry.
- `buildWriteTaskPlan` gains `allowEscalation` and returns `escalated: { from, reason } | null` and
  `reviewRequired`. With a big write and a DIRECT (or `unattended`) policy: `allowEscalation` moves
  it to `worktree` and records the move; without it the plan throws `WRITE_SCOPE_BLOCKED` naming
  both remedies — `--policy worktree`, or let the session escalate it. A big write *asked for* a
  worktree simply runs there; escalation is only ever about DIRECT.
- **The session escalates; a flag interface does not.** `--auto-escalate` is passed by the
  interactive session (`apps/cli/src/repl.ts`), where the operator is shown the escalation in the
  plan and confirms the run. `braingate dogfood write plan|run --policy direct` on a big task exits
  non-zero. Replacing a policy someone typed, in a non-interactive command, is exactly the silent
  decision ADR [0017](0017-direct-execution.md) exists to prevent.
- **The reviewer is cross-provider or the task does not run.** For a big write, `routeWriteReviewer`
  tries `cross-provider` independence only; where no eligible model exists it throws
  `WRITE_REVIEWER_UNAVAILABLE`, naming the signed-in providers and the two fixes (sign in to a
  second CLI, or score one of its models for the reviewer role). Small writes keep the cascade —
  a same-provider reviewer is better than none for an ordinary edit, and is not the independent
  check a migration is being promised. `--no-review` cannot switch a big write's reviewer off.
- **Classification comes before the repository path.** A worktree is prepared by `WorktreeGuard`
  from a *registered repository*; a DIRECT write runs in the attached workspace directory, which may
  be neither. `apps/cli/src/dogfood-cli.ts` therefore classifies, decides escalation, and only then
  chooses the path.
- **A boundary that cannot be built is said before anything is confirmed.** The plan carries
  `worktreeReady { ready, reason, changedFiles }` from `inspectGitRepository`. A dirty or
  commitless checkout gets one message in the session — what kind of change this is, why it needs a
  worktree, how many files are in the way, and that BrainGate will not stash them — and no
  confirmation prompt, because there is nothing to confirm. Nothing is spent.
- The escalation is on the task's own record: a `write.escalated` event and the `planned`
  transition's `executionPolicy` / `escalatedFrom` / `escalationReason`, beside the plan JSON the
  session printed.

### What this amends

- **ADR [0017](0017-direct-execution.md)** — DIRECT remains the ordinary policy for T0–T2
  low/medium work, and is now explicitly *not available* above that line. The invariant that an
  agent never writes the primary checkout except under an attended DIRECT run is unchanged; this
  narrows which work may be attended that way.
- **ADR [0019](0019-a-write-is-a-first-class-task.md)** — a write task's plan and receipt now carry
  the boundary it ran under *and* the boundary it was asked for.
- **ADR [0005](0005-budget-governor.md)** — the budget's `reviewerPolicy: "required"` was already
  the rule for T3/T4 and high/critical risk. This adds the independence requirement: for those
  tasks the reviewer must come from another provider, and an unavailable reviewer is a refusal
  rather than a downgrade.
- **ADR [0008](0008-operator-accepted-providers.md) / [0020](0020-antigravity-direct-is-read-from-its-own-settings.md)** —
  unchanged, and now load-bearing in a second place: the reviewer a big write needs may be a
  provider the operator accepted, and nothing here writes another CLI's settings.
- **ADR [0012](0012-quota-state-is-native-only.md)** — unchanged. An escalation is a routing
  decision; it records no quota state.

### Consequences

- The work BrainGate most obviously exists for — a migration, an auth rewrite — stops being the
  work it refuses. It costs two subscriptions and a merge the operator performs.
- A big write needs two signed-in providers. On a one-subscription machine it is refused by name,
  which is a worse outcome than running unreviewed only if an unreviewed migration was ever an
  outcome worth having.
- Every big write needs a clean checkout with a commit, because every big write is a worktree
  write. The operator is told that before they confirm rather than by a guard afterwards.
- `--no-review` and `--policy direct` no longer mean what they used to for these tasks. Both are
  refused loudly rather than honoured quietly.
