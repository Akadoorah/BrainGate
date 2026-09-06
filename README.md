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

## Planned provider adapters

- Anthropic Claude Code
- OpenAI Codex CLI
- Google Antigravity CLI
- xAI Grok Build

Provider availability is discovered at runtime. BrainGate must continue to work when any provider is unavailable or out of quota.

## Status

Milestone 0 establishes architecture, security boundaries, and repository conventions before provider execution code is introduced.

See `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and `docs/ROADMAP.md`.
