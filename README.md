# BrainGate

**One local control plane for the AI coding subscriptions you already use.**

BrainGate is a private pre-alpha project for coordinating official AI coding CLIs across multiple software projects while keeping project context isolated, controlling quota usage, and recording what every agent did.

**Read this in another language:**
[العربية](docs/i18n/README.ar.md) ·
[Türkçe](docs/i18n/README.tr.md) ·
[Español](docs/i18n/README.es.md) ·
[Français](docs/i18n/README.fr.md) ·
[Deutsch](docs/i18n/README.de.md) ·
[Português (BR)](docs/i18n/README.pt-BR.md) ·
[Русский](docs/i18n/README.ru.md) ·
[简体中文](docs/i18n/README.zh-CN.md) ·
[日本語](docs/i18n/README.ja.md) ·
[한국어](docs/i18n/README.ko.md) ·
[हिन्दी](docs/i18n/README.hi.md)

English is the source of truth. Translations cover installation and first use; the rest of
this document and everything under `docs/` is English only.

---

## Requirements

| | |
|---|---|
| Node.js | 22 or later |
| Git | any recent version |
| pnpm | through Corepack (`corepack enable`) |
| A provider CLI | at least one official CLI, already signed in to a subscription you control |

BrainGate never asks for an API key. It drives the provider CLIs you already sign into, and it
strips known API-key and base-URL variables from the subprocesses it starts, so a stray
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` cannot silently move you onto per-token billing.

Provider support today:

| Provider | CLI | Status |
|---|---|---|
| Anthropic Claude Code | `claude` | read and write |
| OpenAI Codex | `codex` | planning, review and judging, after an isolation self-test; writes once you score it for the role |
| GitHub Copilot | `copilot` | read only, subscription attested by you |
| Google Antigravity | `agy` | planning, review and judging — after you accept the risk below |
| xAI Grok Build | `grok` | planning, review and judging, after a sandbox self-test; writes once you score it for the role |

Run `braingate providers list` to see which roles each provider may take on your machine, and
why the closed ones are closed.

### How a provider earns a role

BrainGate will not send your work to a CLI it cannot say something definite about. There are two
ways a provider becomes usable, and they are not interchangeable.

**Proven, per run.** Codex and Grok can both be pointed at a configuration BrainGate controls, so
what they may do during a run is *measured* rather than trusted — and re-measured every time,
because the CLI may have been updated since. Codex takes a permission profile through
`CODEX_HOME`; Grok takes a kernel sandbox (Seatbelt on macOS, Landlock on Linux) defined in the
staged workspace itself. Both self-tests cost nothing: each reads a decision the CLI has already
made, before any model call. If the self-test fails, the provider is not offered.

**Accepted, by you.** Antigravity keeps its settings and its credentials under the same `HOME`
and offers no second variable to separate them, so BrainGate cannot hand it a scoped
configuration for one call. Nothing here can prove what such a run may reach, so nothing tries:
it stays closed until you say otherwise.

```bash
braingate providers accept google      # opens planning, review and judging
braingate providers revoke google      # closes them again
```

> [!WARNING]
> **What accepting means.** BrainGate cannot limit what an unscoped provider reaches *outside*
> your project. It may read or write elsewhere on your machine, and no guard here sees that. It
> is the same exposure as running `agy` yourself — which is why accepting it is reasonable — but
> it is not zero. Accepting also records that you are signed in with a subscription rather than
> direct API billing, because the CLI does not report which.
>
> What does **not** change: an accepted provider still reaches only planning, review and
> judging, each in a temporary directory that never contains your project. Writes still happen
> in a task worktree, your checkout is fingerprinted before and after, every changed path passes
> the diff guard, and nothing merges without you. Those verify the outcome, so they hold whether
> or not the provider was isolated going in. Acceptance widens which providers may be *asked*,
> never what any provider may leave behind.

Acceptance is per provider, recorded with a timestamp, expires after 30 days, and is never
inferred from a provider being installed or signed in. A fresh installation routes to nothing
that has neither proven itself nor been accepted.

### How often a self-test runs

Both self-tests are cheap in tokens and not in time, so a passing proof is remembered for a
short while rather than re-earned on every command. It is never treated as more than it is: what
comes back is re-validated against the provider snapshot taken moments ago, so a CLI that has
been updated, a policy whose hash has moved, or an entry past its own expiry falls through to a
fresh test. The provider's own configuration — the sandbox file, MCP servers, hooks — is re-read
every time and folded into the key, because that is what goes stale fastest and a version string
cannot see it. And reuse stops far short of the day an attestation claims to be valid, since the
record sits in your own home.

`braingate doctor` always measures. Delete `~/.braingate/global/isolation-attestations.json` to
force the next command to measure too.

### What is still not scoped, even when a self-test passes

Grok's credentials live in your own `~/.grok`, and BrainGate will not copy them out to get a
clean home. So that home's configuration loads inside the sandbox with the run:

- **MCP servers stop the run.** An MCP server is an arbitrary process with its own network
  access and no per-invocation off switch. Disable them (`grok mcp`) or Grok stays closed.
- **Hooks and marketplace plugins are named, not blocked.** `braingate doctor` prints
  `grok-home-loads=...` so you can see what came along.
- **Network blocking is Linux-only.** `restrict_network` is enforced by seccomp on Linux and is
  a documented no-op on macOS. The attestation records which, so no receipt overclaims.

None of these can reach your project — the sandbox is kernel-enforced and confined to the staged
workspace — but they are inside the run, and saying so is better than implying otherwise.

See [`docs/adr/0008-operator-accepted-providers.md`](docs/adr/0008-operator-accepted-providers.md)
and [`docs/adr/0009-grok-sandbox-is-provable.md`](docs/adr/0009-grok-sandbox-is-provable.md).

## Install

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck && pnpm test
```

Then put `braingate` on PATH — the launcher resolves its own location, so a symlink is enough.
Nothing is copied and nothing is installed globally:

```bash
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
braingate
```

The symlink points into this checkout, so the command stops working if the repository is moved,
renamed, or lives on a volume that is not mounted.

## Interactive session

Run `braingate` with no arguments at a terminal and it opens a session, the way the provider
CLIs it wraps do:

```
$ braingate

  ▌  B R A I N G A T E
  ▌  · · · · ◈ · · · ·
  ▌  route each task to the cheapest worker that can do it

  Dogfood preflight demo-api: ask=ready · write=ready · configured=5 · model calls=0
  Type a request, or /help. Nothing is spent until you confirm.

> what theme value is in config.yml?

  read-only · T1/low · primary=anthropic/claude-sonnet-5
  Run it? [y/N] y

dark

Task 3aceddf1 · observed=1 · outcome=completed_without_review
```

Type a request in plain words. A question is answered; an instruction to change something is
recognised as a write and planned into an isolated worktree. Either way the plan is shown
first — classification, the model that would run, any reviewer — and nothing is spent until you
confirm. **The `--execute` gate does not disappear here; it becomes that confirmation.** If the
intent is guessed wrongly, the line says `write · isolated worktree` before you answer, so a
wrong guess costs a keystroke rather than a change.

Follow-ups resolve against earlier turns, so `and the other one?` means something. That thread
never becomes project memory — an unverified answer must not acquire the standing of a promoted
record by passing through a conversation. `/forget` drops it; project memory is untouched.

**The thread is written to disk**, because closing a terminal is not the same as changing the
subject. It is kept with the project's own state, so two projects cannot see each other's; it
holds the last six exchanges with each answer truncated to 1,200 characters; it is passed through
the secret redactor before it is written; and it expires eight hours after the last turn. Come
back within that window and the session says how many turns it is continuing. `/forget` deletes
the file, not merely the memory of it. Nothing else about the boundary changed: a turn is still
not memory, and still reaches canonical status only through the same proposal gate.

Beyond that window, `/status` lists your recent tasks by what you asked, with the models
that ran and what each spent. The request is your own text and is recorded; the answer and the
model's reasoning are not, and never leave the process. Nothing there is fed back to a model —
if you want BrainGate to *know* something in later sessions, that is `braingate memory`, which
takes evidence before a claim becomes canonical.

`/help`, `/status`, `/models`, `/providers`, `/doctor`, `/feedback`, `/forget`, `/exit` cover
the rest.

Arriving in a repository BrainGate does not know is the ordinary first run, so the session
offers to register it there and then rather than printing an instruction and exiting.

While a request is in flight the same motif keeps moving, with the seconds counted:

```
  ▌  · · ▸ · ◈ · · · ·  working · 18s
```

That count is the useful part. A visual task runs for minutes and a T4 audit longer, and the
elapsed time is what distinguishes a normal run from a stuck one. The indicator erases itself
before the first byte of the answer, so it never shares a line with output.

`NO_COLOR` drops the colour, `BRAINGATE_NO_ANIMATION=1` draws the banner in one frame and
suppresses the indicator, and a `dumb` terminal gets both. Where the line cannot be redrawn
nothing is drawn at all, because an indicator that cannot erase itself leaves every frame in
the log.

Piped or scripted, `braingate` prints its command listing instead, so nothing reading its output
changes behaviour. The flag interface below is unchanged and remains the scripting surface.

## Quickstart

**1. Check what BrainGate can see.** Sign in with each provider's own CLI first (`claude`,
`codex login`, and so on), then:

```bash
braingate discover
```

Authentication that cannot be proven is reported as `unknown` rather than assumed.

**2. Configure the model catalog.** BrainGate does not invent model ids, context capacities, or
capability scores, so you declare the models you want it to route to. The catalog is global:
configure it once and every project uses it.

```bash
cat > claude-model.json <<'JSON'
{
  "providerId": "anthropic",
  "modelId": "<MODEL_ID_YOU_HAVE_VERIFIED>",
  "quotaPool": "claude-subscription",
  "capabilities": { "coder": 88, "reviewer": 84, "judge": 82 },
  "speed": "balanced",
  "contextCapacity": 200000,
  "writeCapable": true,
  "reasoning": 85,
  "underlyingFamily": null
}
JSON

braingate models add --definition claude-model.json
braingate models profile
```

Add one entry per model you want available. `speed` is `fast`, `balanced`, or `deep`, and it is
the cheap-first lever: `fast` is favoured on simple tasks, `deep` on hard ones. The scores are
your routing policy — see [`docs/ROUTING_AND_REVIEW.md`](docs/ROUTING_AND_REVIEW.md).

**3. Register a repository.**

```bash
cd /path/to/your/project
braingate init
```

It proposes a project id from the directory name and asks you to confirm. The id is the
isolation boundary — memory, worktrees, and telemetry are scoped to it — so BrainGate never
picks one silently. Pass `--project-id <id> --name <name>` to skip the prompt in scripts.

**4. Check readiness. This spends nothing.**

```bash
braingate dogfood preflight
```

**5. Ask a question.** Always plan first: a plan makes no provider call and shows you the
classification, which model would run, and whether a reviewer is required.

```bash
braingate dogfood ask plan --task "Where is the theme configuration defined?"
braingate dogfood ask run  --task "Where is the theme configuration defined?" --execute
```

`--execute` is the only gate that reaches a model. Nothing before it costs quota.

**6. Record what the task actually turned out to be.** This is how routing improves.

```bash
braingate dogfood feedback --task-id <TASK_UUID> --actual-complexity T1 --outcome success
```

**7. Make a small change.** Writes need a clean checkout, and they land in a task worktree —
never in your working tree.

```bash
braingate dogfood write plan --task "Change the empty-state label from X to Y"
braingate dogfood write run  --task "Change the empty-state label from X to Y" --execute
```

Review the branch it reports and merge it yourself if you want it. BrainGate performs no merge,
push, or deploy.

## What it will and will not do

| It does | It never does |
|---|---|
| Route each task to the cheapest capable model | Read or copy provider auth-token files |
| Add an independent reviewer for risky work | Write to your checkout — changes go to a task worktree |
| Verify afterwards that your checkout is untouched | Merge, push, or deploy anything |
| Label usage `native`, `measured`, `estimated`, or `unknown` | Present an estimate as a measurement |
| Keep memory, worktrees, and telemetry per project | Carry context across project boundaries by default |
| Block high-risk and T3/T4 writes outright | Store credentials, `.env` contents, or secrets in memory |

## Verifying it actually works

`pnpm test` runs the full suite with no provider calls, which proves BrainGate's own logic but
not that an installed CLI produced a real result. Two opt-in integration tests close that gap by
driving real providers against a throwaway repository:

```bash
pnpm test:integration
```

They spend real subscription quota and never run in CI. Run them after upgrading a provider CLI
or touching a provider profile. See [`docs/DOGFOOD.md`](docs/DOGFOOD.md).

## Documentation

| | |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | how the pieces fit together |
| [`docs/SECURITY.md`](docs/SECURITY.md) | the security boundaries and why they hold |
| [`docs/SAFE_EXECUTION.md`](docs/SAFE_EXECUTION.md) | worktrees, command allowlists, fail-closed rules |
| [`docs/ROUTING_AND_REVIEW.md`](docs/ROUTING_AND_REVIEW.md) | how a task is classified and routed |
| [`docs/DOGFOOD.md`](docs/DOGFOOD.md) | trialling BrainGate on a real repository |
| [`docs/PROVIDER_DISCOVERY.md`](docs/PROVIDER_DISCOVERY.md) | what is probed per provider, and why fields stay `unknown` |
| [`docs/MEMORY_AND_CONTEXT.md`](docs/MEMORY_AND_CONTEXT.md) | the memory model and its single validated write path |
| [`docs/adr/`](docs/adr) | accepted architecture decisions |
| [`AGENTS.md`](AGENTS.md) | rules for coding agents working in this repository |

---

## Core principles

- **Subscription-first:** use official provider CLIs and their existing account sessions; no token scraping or private endpoints.
- **One Brain, many workers:** BrainGate routes tasks; provider models are replaceable workers.
- **Project isolation by default:** memory, skills, worktrees, context, and dogfood telemetry are scoped to an explicit project ID.
- **Cheap-first escalation:** use the least expensive capable worker and escalate only when complexity or risk requires it.
- **Council is exceptional:** multi-model deliberation is invoked only for high-risk disagreements or explicit requests.
- **No direct writes to the real branch:** coding work happens in isolated Git worktrees and requires verification before human approval.
- **Auditable:** every task has a brief, execution ledger, usage evidence, verification, and final receipt.
- **Secrets are not memory:** credentials are blocked from memory and denied to agents by default.

## Open-source and commercial direction

BrainGate Core is intended to become a genuinely useful open-source local developer tool. The future commercial layer should add value that is naturally cross-device, team-oriented, centrally administered, or enterprise-focused—such as BrainGate Cloud, encrypted sync, remote approvals/control, organization policy, fleet observability, compliance, and managed support—without deliberately crippling local Community functionality.

The current preferred licensing direction is Apache-2.0, but **the repository is not licensed under Apache-2.0 merely because it is the preferred direction**. A final license, third-party attribution audit, contributor policy, trademark/name review, and public-release security/community artifacts must be completed before a public launch.

The default business assumption is bring-your-own independently authorized provider subscriptions/accounts. BrainGate should not rely on reselling model access, credential pooling, token scraping, private provider endpoints, or usage-limit circumvention.

See:

- [`docs/OPEN_SOURCE_AND_COMMERCIAL.md`](docs/OPEN_SOURCE_AND_COMMERCIAL.md) — intended OSS/commercial boundary, business model, pricing hypotheses, architecture seams, and moat thesis.
- [`docs/PUBLIC_RELEASE_CHECKLIST.md`](docs/PUBLIC_RELEASE_CHECKLIST.md) — concrete prerequisites before making the project public or charging for cloud/team features.
- [`docs/PRODUCT.md`](docs/PRODUCT.md) — product definition and business principles.

## Current local operator

`braingate` works from any directory. Commands that act on a project read `.brain/project.json`
from the current directory, so the project is whichever repository you are standing in;
`--project <manifest>` overrides that. Run it outside a registered project and it says so
rather than failing obscurely.

The full command surface:

- `braingate init --project-id <id> --name <name>`
- `braingate discover`
- `braingate doctor --project <manifest>`
- `braingate models list|validate|add|remove|import-discovered|profile`
- `braingate memory note|preview|import|promote|list|proposals`
- `braingate shadow plan|run ...`
- `braingate write plan|run ...` — add `--visual "<description>" --visual-to <path>` to have an image generated alongside the change
- `braingate dogfood preflight`
- `braingate dogfood ask plan|run ...`
- `braingate dogfood write plan|run ...`
- `braingate dogfood feedback ...`
- `braingate dogfood report`
- `braingate dogfood export`
- `braingate status --project <manifest>`
- `braingate dashboard --project <manifest>`

`plan` and `run` without `--execute` do not make provider model calls. The explicit `--execute` flag is the model-execution gate.

`braingate init` creates a local ignored `.brain/project.json`, so dogfood and memory commands can use the current project without repeatedly passing a manifest path.

See [`docs/DOGFOOD.md`](docs/DOGFOOD.md) for the real-project trial workflow.

## Asking for an image

A write task can produce one, in the same worktree and behind the same review:

```bash
braingate write run --project .brain/project.json \
  --task "reference the hero image in the README" \
  --visual "a flat blue circle centred on a white background" \
  --visual-to assets/hero.png --execute
```

The generating pass runs read-only against the worktree — the image is written into the
provider's own directory and collected from there, so producing one needs no write access to
your project at all. The file goes through the same containment, symlink, size and magic-byte
checks as any other change, appears in the reviewed diff as a summary rather than as inlined
bytes, and merges only when you say so.

`--visual-to` is required because the provider cannot supply it: it knows what it drew, not
where your project keeps it. Routing picks whichever configured model declares a `visual`
capability, and says so if none does.

## Spreading load across the pools you pay for

Routing by capability alone sends every role to the strongest model every time, which is not
what paying for several subscriptions is for. The signal that would move it — quota pressure —
was always `unknown`, because no provider publishes a remaining balance and nothing else filled
it in.

BrainGate does know one thing about quota: what it spent itself. Provider token counts are
recorded natively, so pools can be compared against each other. The busiest recent pool scores
1, the quietest 0, and the router leans away from the busy one — enough to hand planning to a
different subscription when one has been carrying the day, and to hand it back when the load
evens out.

It is a *relative* signal and is labelled as one. It does not claim to know any pool's limit,
because nobody publishes one and a made-up ceiling would be a number pretending to be authority.
Three rules keep it honest:

- **A provider that reports a real balance outranks it.** The local reading is recorded under
  its own metric name as `measured`, never as `pressure`, so a receipt can say which was used.
- **A pool nobody measured has no signal, not a zero.** Codex and Copilot report no token counts.
  Reading silence as "idle" would send them everything.
- **One measured pool is not a comparison.** With nothing to be relative to, there is no signal.

`braingate doctor --json` shows the reading per model. Deleting
`~/.braingate/global/quota.sqlite` forgets the history and starts again.

## How memory reaches a task

Canonical project memory is retrieved for every task and travels with it, so a decision you
recorded once is available the next time it matters. Records are selected by relevance to the
task, bounded to a share of that task's own context budget — a T0 lookup does not carry a T4
task's worth of history — and whatever did not fit is counted in the receipt rather than
silently dropped.

Only canonical records are read. A proposal is not memory: it becomes canonical solely through
`memory promote`, which requires explicit evidence, and injecting proposals into tasks would
route around that gate. Secrets never enter memory in the first place, so they cannot arrive
here.

Memory is per project, not shared between them. Each registered project gets its own SQLite
database under its own storage directory, and every query is additionally filtered by project
id, so one project's decisions are not reachable from another.

An interactive session's thread is a separate, weaker thing: project-local, redacted, bounded to
six turns, expiring after eight hours, and never promoted. It is written to disk so a session
survives a closed terminal — see the interactive session section above for exactly what is kept.
Keeping the two apart is what stops an unverified answer from acquiring the standing of a
verified one.

The task ledger is a third thing again, and neither of the first two: a project-local record of
what you asked, which models took which role, what each reported spending, and how the task
ended. It is history you can read, not context a model is given. Provider output stays out of
it — an answer or a chain of reasoning can carry file contents nobody chose to write down —
while your own request is kept, redacted of anything secret-shaped, because a history that
cannot say what a task was about is not history.

## Memory bootstrap

Existing project history can be imported from local Markdown/text, normalized JSONL, or a best-effort ChatGPT-style `conversations.json` export. BrainGate does not scrape provider sessions or authentication state to obtain chat history.

The import boundary is deliberately conservative:

- `memory preview` persists nothing;
- `memory import` creates project-scoped **proposals only**;
- imported claims are never canonical automatically;
- `memory promote` requires explicit evidence and confidence through the existing supervisor path;
- canonical duplicates are skipped;
- ChatGPT-style history is compacted into bounded historical observations rather than retaining or injecting entire transcripts.

This keeps Git/code/tests and verified canonical records above old conversational claims in the source-of-truth hierarchy.

## Single-provider mode

BrainGate does not require several vendors. A user with only one provider can configure multiple provider-owned model IDs with capability, speed, context, and quota metadata. Routing remains capability-based rather than hard-coding names such as Haiku, Sonnet, Opus, or GPT variants.

`braingate models profile` reports T0-T4 coverage, speed classes, quota-pool declarations, and the strongest available reviewer independence level.

Reviewer preference order is:

1. cross-provider;
2. same provider, different model, fresh invocation;
3. same model, fresh invocation only when no stronger independence is available.

The receipt labels this distinction explicitly. Models from one subscription are not treated as fake independent providers or quota pools. Critical tasks still require cross-provider/separate-authority review; T4 work without it remains human-approval gated.

## M12 dogfood telemetry

M12 records project-local experiment metadata so routing can be evaluated against real work without turning provider sessions into canonical memory.

The dogfood database stores classification/risk predictions, effective routing floors, provider/model roles, reviewer verdicts, outcome labels, usage evidence, and user feedback. It does **not** persist raw task text, model answers, provider reasoning, secrets, or candidate diffs.

Adaptive priors are deliberately conservative: they require at least three labeled samples and a sustained underprediction signal before activation, apply independently per project and `ask`/`write` mode, and can only raise complexity/risk floors. BrainGate does not automatically rewrite model scores or silently de-escalate tasks.

## Provider status

Provider model names are not hard-coded into BrainGate. A persistent local model catalog stores scored model definitions, while runtime discovery verifies which official CLIs, authentication modes, and quota evidence are actually available.

Current hardened execution paths:

- **Anthropic Claude Code:** restricted read-only shadow path and M11 small-write primary path inside guarded task worktrees.
- **OpenAI Codex CLI:** planning, review and judging from a staged workspace when `codex login status` proves ChatGPT authentication and a local zero-model-call sandbox self-test proves the required filesystem policy for the installed Codex version. It may also hold the executing role, in a task worktree under `workspace-write`, once you score a Codex model for it.
- **GitHub Copilot CLI:** bounded read-only path when subscription authentication is explicitly attested where safe native discovery is unavailable.
- **xAI Grok Build:** planning, review and judging, in a kernel-sandboxed staged workspace proven per run; never the project checkout. It may also hold the executing role, in a task worktree under a custom kernel profile whose deny list puts secrets out of reach, once you score a Grok model for it.
- **Google Antigravity:** the same three roles, reachable only after `braingate providers accept google`, because its isolation cannot be proven.

Codex review runs from a fresh staged workspace rather than the real repository. Native Windows Codex review is blocked in this milestone; WSL uses the Linux path and must still pass the self-test.

## Write boundary

Current writes are intentionally narrow:

- Claude is the only write-capable primary provider in the current dogfood path;
- writes occur only inside task-specific BrainGate worktrees;
- source checkout mutation is treated as an invariant failure;
- sensitive paths and BrainGate/agent control files are rejected;
- `git diff --check` is required;
- reviewer rejection makes the task not ready for approval;
- high/critical-risk and T3/T4 writes remain blocked;
- no automatic merge, push, deploy, or production-secret access exists.

## Privacy and billing boundaries

- BrainGate does not read or copy provider auth-token files.
- Known API-key/direct-billing environment variables are removed from subscription child processes.
- Raw task text is not used as the persisted task title.
- Provider reasoning/event streams are not persisted as canonical task output.
- Imported conversation history is proposal input, not automatic canonical memory.
- Usage is labeled by evidence quality (`native`, `measured`, `estimated`, or `unknown`) rather than invented.

## Status

Milestones 0–12 establish the deterministic core, project/task isolation, canonical memory, routing, observability, hardened subscription execution, independent Codex review, guarded worktree-only writes, and real-project dogfood telemetry. Milestone 13 adds safe memory bootstrap and graded single-provider routing so the first real project trial can start with useful historical context and still work well with only one AI subscription provider.

See `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/ROADMAP.md`, `docs/DOGFOOD.md`, and `docs/PRETRIAL.md`.
