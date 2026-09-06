# @braingate/providers

Safe provider discovery and, later, execution adapters for official AI coding CLIs.

Milestone 3 deliberately supports **metadata discovery only**. It never sends a model prompt, opens an interactive status session, copies OAuth tokens, or intentionally falls back to direct API billing.

Current provider identities:

- Claude Code (`claude`)
- OpenAI Codex (`codex`)
- Google Antigravity (`agy`)
- xAI Grok Build (`grok`)
- GitHub Copilot CLI (`copilot`)

All unsupported or unsafe-to-probe fields are returned as `unknown`, not guessed.
