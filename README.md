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
| OpenAI Codex | `codex` | independent reviewer only, after an isolation self-test |
| GitHub Copilot | `copilot` | read only, subscription attested by you |
| Google Antigravity | `agy` | discovery only; execution fail-closed |
| xAI Grok Build | `grok` | discovery only; execution fail-closed |

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
is ephemeral: it lives in the session process only, is never written to disk, and never becomes
project memory — an unverified answer must not acquire the standing of a promoted record by
passing through a conversation. `/forget` drops it; project memory is untouched.

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
- `braingate memory preview|import|promote|list`
- `braingate shadow plan|run ...`
- `braingate write plan|run ...`
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

An interactive session's thread is a separate, weaker thing: ephemeral, in-process, never
written to disk, and never promoted. Keeping the two apart is what stops an unverified answer
from acquiring the standing of a verified one.

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
- **OpenAI Codex CLI:** independent **reviewer-only** path when `codex login status` proves ChatGPT authentication and a local zero-model-call sandbox self-test proves the required filesystem policy for the installed Codex version.
- **GitHub Copilot CLI:** bounded read-only path when subscription authentication is explicitly attested where safe native discovery is unavailable.
- **Google Antigravity / xAI Grok Build:** discovery exists, but automated execution remains fail-closed until equivalent isolation is proven.

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
