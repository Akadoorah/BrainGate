# BrainGate

**One local control plane for the AI coding subscriptions you already use.**

BrainGate is a private pre-alpha project for coordinating official AI coding CLIs across multiple software projects while keeping project context isolated, controlling quota usage, and recording what every agent did.

## Core principles

- **Subscription-first:** use official provider CLIs and their existing account sessions; no token scraping or private endpoints.
- **One Brain, many workers:** BrainGate routes tasks; provider models are replaceable workers.
- **Project isolation by default:** memory, skills, worktrees, context, and dogfood telemetry are scoped to an explicit project ID.
- **Cheap-first escalation:** use the least expensive capable worker and escalate only when complexity or risk requires it.
- **Council is exceptional:** multi-model deliberation is invoked only for high-risk disagreements or explicit requests.
- **No direct writes to the real branch:** coding work happens in isolated Git worktrees and requires verification before human approval.
- **Auditable:** every task has a brief, execution ledger, usage evidence, verification, and final receipt.
- **Secrets are not memory:** credentials are blocked from memory and denied to agents by default.

## Current local operator

The repository includes a local `braingate` CLI with:

- `braingate init --project-id <id> --name <name>`
- `braingate discover`
- `braingate doctor --project <manifest>`
- `braingate models list|validate|add|remove|import-discovered`
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

`braingate init` creates a local ignored `.brain/project.json`, so M12 dogfood commands can use the current project without repeatedly passing a manifest path.

See [`docs/DOGFOOD.md`](docs/DOGFOOD.md) for the real-project trial workflow.

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

- Claude is the only write-capable primary provider in M11/M12.
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
- Usage is labeled by evidence quality (`native`, `measured`, `estimated`, or `unknown`) rather than invented.

## Status

Milestones 0–11 establish the deterministic core, project/task isolation, memory, routing, observability, hardened subscription execution, independent Codex review, and guarded worktree-only writes. Milestone 12 adds real-project onboarding, sanitized dogfood telemetry, conservative project-local routing priors, feedback/report/export workflows, and the trial path documented in `docs/DOGFOOD.md`.

See `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/ROADMAP.md`, and `docs/DOGFOOD.md`.
