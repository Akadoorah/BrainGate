# BrainGate

**One local control plane for the AI coding subscriptions you already use.**

BrainGate is a private pre-alpha project for coordinating official AI coding CLIs across multiple software projects while keeping project context isolated, controlling quota usage, and recording what every agent did.

## Core principles

- **Subscription-first:** use official provider CLIs and their existing account sessions; no token scraping or private endpoints.
- **One Brain, many workers:** BrainGate routes tasks; provider models are replaceable workers.
- **Project isolation by default:** memory, skills, worktrees, and context are scoped to an explicit project ID.
- **Cheap-first escalation:** use the least expensive capable worker and escalate only when complexity or risk requires it.
- **Council is exceptional:** multi-model deliberation is invoked only for high-risk disagreements or explicit requests.
- **No direct writes to the real branch:** coding work happens in isolated Git worktrees and requires verification before merge.
- **Auditable:** every task has a brief, execution ledger, usage evidence, file activity, test results, and final receipt.
- **Secrets are not memory:** credentials are blocked from memory and denied to agents by default.

## Current local operator

The repository now includes a local `braingate` CLI with:

- `braingate discover`
- `braingate doctor --project <manifest>`
- `braingate models list|validate|add|remove|import-discovered`
- `braingate shadow plan --project <manifest> --task <text>`
- `braingate shadow run --project <manifest> --task <text> [--execute]`
- `braingate status --project <manifest>`
- `braingate dashboard --project <manifest>`

`shadow plan` and `shadow run` without `--execute` do not make provider model calls. The explicit `--execute` flag is the execution gate for shadow model calls.

## Provider status

Provider model names are not hard-coded into BrainGate. A persistent local model catalog stores scored model definitions, while runtime discovery verifies which official CLIs, authentication modes, and quota evidence are actually available.

Current hardened shadow paths:

- **Anthropic Claude Code:** read-only primary/reviewer path with subscription authentication and restricted tools.
- **OpenAI Codex CLI:** independent **reviewer-only** path when `codex login status` proves ChatGPT authentication and a local zero-model-call sandbox self-test proves the required filesystem policy for the installed Codex version.
- **GitHub Copilot CLI:** bounded read-only path when subscription authentication is explicitly attested where safe native discovery is unavailable.
- **Google Antigravity / xAI Grok Build:** discovery exists, but automated shadow execution remains fail-closed until equivalent isolation is proven.

Codex review runs from a fresh staged workspace rather than the real repository. Native Windows Codex review is blocked in this milestone; WSL uses the Linux path and must still pass the self-test.

## Privacy and billing boundaries

- BrainGate does not read or copy provider auth-token files.
- Known API-key/direct-billing environment variables are removed from subscription child processes.
- Raw task text is not used as the persisted task title.
- Provider reasoning/event streams are not persisted as canonical task output.
- Usage is labeled by evidence quality (`native`, `measured`, `estimated`, or `unknown`) rather than invented.

## Status

Milestones 0–9 established the deterministic core, project/task isolation, memory, routing, observability, shadow execution, and local operator CLI. Milestone 10 hardens Codex as an independent staged reviewer.

See `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and `docs/ROADMAP.md`.
