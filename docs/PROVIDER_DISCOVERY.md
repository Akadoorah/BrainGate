# Provider discovery policy

_Last verified against official provider documentation: 2026-09-07._

BrainGate treats provider discovery as a zero-prompt metadata operation. Discovery is intentionally less informative than an interactive provider session when the only way to learn a field would be to invoke a model.

## Invariants

1. Discovery never sends user/model prompt text.
2. Only an exact allowlist of metadata commands may be spawned.
3. Known direct-billing API-key/base-URL environment overrides are removed from child processes.
4. OAuth/session credentials remain owned by the provider CLI and OS keychain; BrainGate never reads or persists them.
5. Missing or ambiguous auth, model, plan, or quota information is `unknown`.
6. Discovery runs outside project working directories and has no project write path.
7. Model names are opaque provider-owned strings. Routing semantics are never inferred from a name during discovery.

## Verified command surfaces

### Claude Code

- `claude --version` is documented for install verification.
- Claude exposes `/status` interactively, but BrainGate does not open an interactive/model session solely to probe account state.
- A stray `ANTHROPIC_API_KEY` can override account login, so subscription probes strip it.

Official references:
- https://support.claude.com/en/articles/14552382-your-first-day-in-claude-code
- https://support.claude.com/en/articles/14553413-claude-code-cheatsheet

### OpenAI Codex

- Codex supports ChatGPT account sign-in and an interactive `/status` usage surface.
- BrainGate uses local `--version`/`--help` metadata only in this milestone; account/rate-limit integration will be added only through a documented machine-readable status surface.
- `OPENAI_API_KEY` and `OPENAI_BASE_URL` are stripped from subscription-mode probes.

Official reference:
- https://help.openai.com/en/articles/11369540

### Google Antigravity

- `agy models` is the documented model-slug listing surface.
- Headless model prompts use `-p`; discovery explicitly forbids it.
- Cached account credentials live in the OS keyring. Antigravity can also be configured for `GEMINI_API_KEY`, so BrainGate strips API-key/base-URL overrides for subscription discovery.

Official references:
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/install/

### xAI Grok Build

- `grok version` and `grok models` are documented metadata commands.
- `grok -p` is headless inference and is forbidden during discovery.
- `XAI_API_KEY` is stripped from subscription discovery.
- Authentication is `native`. `grok models` names the signed-in account before it lists anything,
  and it neither prompts nor mutates — which is the bar. It was recorded as `unknown` only
  because nothing read its output; the same run answers both questions, so the command is issued
  once rather than twice.

Official references:
- https://docs.x.ai/build/cli/reference
- https://docs.x.ai/build/overview

### GitHub Copilot CLI

- `copilot version` and `copilot help` are documented command-line metadata surfaces.
- Available model slugs are exposed through interactive `/model`; BrainGate does not launch a model session just to scrape them.
- Programmatic `-p` interactions consume AI credits and are forbidden during discovery.
- GitHub account auth variables are not direct LLM billing overrides and may remain available; BYOK provider variables are stripped.

Official references:
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference
- https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli

## Why auth and usage can be `unknown`

A truthful `unknown` is safer than spending quota, scraping provider credentials, or depending on an undocumented private endpoint. Future provider adapters may upgrade a field to `native` only when the installed official CLI exposes a stable, machine-readable, zero-prompt surface.

That upgrade is expected to happen, and did: Grok's authentication moved from `unknown` to
`native` once its existing zero-prompt command was actually read. A field left `unknown` because
nobody looked is a different thing from one that is genuinely unavailable, and it is worth
re-checking when a provider ships.

## What discovery costs, and what is remembered

Probes run together rather than one after another, and a command that answers two questions is
issued once — `grok models` reports the model list and the signed-in account, and two concurrent
copies would also write the same model cache.

The model list is the only probe that leaves the machine, and the only one remembered: for an
hour, keyed by the CLI's own version so an update invalidates it. It is never remembered for a
provider whose model command also reports sign-in, because a cached "signed in" that outlives a
sign-out would route work to a provider that will refuse it. Authentication is measured every
time.
