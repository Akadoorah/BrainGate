# BrainGate

**One local control plane for the AI coding subscriptions you already use.**

[![CI](https://github.com/Akadoorah/BrainGate/actions/workflows/ci.yml/badge.svg)](https://github.com/Akadoorah/BrainGate/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Status: technical preview](https://img.shields.io/badge/status-technical%20preview-orange.svg)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

You pay for Claude Code, Codex, Antigravity, Grok or Copilot. Each one starts every session from
nothing, and none of them knows what the others found. BrainGate sits in front of the official CLIs
you already signed into and gives them **one conversation, one goal and one memory per project**.
Switch from Claude to Grok to Codex in the middle of a task, and the next worker picks up where the
last one stopped.

[العربية](docs/i18n/README.ar.md) · [Türkçe](docs/i18n/README.tr.md) · [Español](docs/i18n/README.es.md) ·
[Français](docs/i18n/README.fr.md) · [Deutsch](docs/i18n/README.de.md) · [Português (BR)](docs/i18n/README.pt-BR.md) ·
[Русский](docs/i18n/README.ru.md) · [简体中文](docs/i18n/README.zh-CN.md) · [日本語](docs/i18n/README.ja.md) ·
[한국어](docs/i18n/README.ko.md) · [हिन्दी](docs/i18n/README.hi.md)

<!-- TODO(operator): replace this transcript with a recorded GIF of the same session. -->

```text
$ braingate
> Investigate why the mobile app logs the user out when it is idle

  read-only · direct · in your workspace · T2/medium · primary=anthropic/claude-sonnet-5
  Run it? [y/N] y
  … Claude Code reads the repository with its own tools and answers …

> /why
  Route for task 4f2a91c3-8d0e-4b6a-9c51-2e7d0a13f6b8:
    primary: anthropic/claude-sonnet-5 — capability:95, reasoning:90, quota:unknown, tier:T2

> /use grok
> Do you agree with that diagnosis?

  read-only · direct · in your workspace · T2/medium · primary=xai/grok-4.6
  continues goal 4f2a91c3 · diagnosed

> /use claude
> Now apply the fix you proposed

  write · direct · in your workspace · T2/medium · primary=anthropic/claude-sonnet-5
  session: resuming native session 9c1d4e77 · delta: 2 turn(s) by another worker
```

## Why BrainGate

- **Workers are swappable, the goal is not.** A new worker is handed what the goal already
  established. A returning worker resumes its own native session and is told only what changed.
- **Each CLI stays itself.** BrainGate launches `claude`, `codex`, `agy`, `grok` or `copilot` and lets
  it use its own tools, subagents, MCP servers and permission prompts. BrainGate chooses who does the
  work; it does not micromanage how.
- **Nothing is spent until you confirm.** Every request is planned first, at no cost, and `/why`
  shows which worker won and why every other one was set aside.
- **Big changes move out of your checkout.** A migration or auth rewrite runs in an isolated
  worktree with a reviewer from a different provider, and the merge is yours.
- **Memory needs evidence.** A worker's claim stays a claim until you promote it with evidence.
  Memory, worktrees and telemetry are isolated per project.

## What it is not

- **Not a credential broker.** It never asks for an API key and never reads or copies your provider
  tokens. It strips known API-key variables from the processes it starts, so a stray
  `ANTHROPIC_API_KEY` cannot silently move you onto per-token billing.
- **Not a way around a subscription.** It spends your own subscriptions, through the official CLIs,
  under each provider's terms. A refusal or rate limit is a stop, never something it retries past.
  See [Responsible use](docs/GUIDE.md#responsible-use).
- **Not a new model or agent harness.** There is no BrainGate model. It is software that runs other
  people's CLIs.

## Quick start

You need Node.js 22+, Git, and at least one provider CLI already signed in to a subscription you
control.

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable && pnpm install
ln -s "$PWD/apps/cli/bin/braingate.mjs" ~/.local/bin/braingate
```

Then, inside any project:

```bash
cd ~/code/my-service
braingate
```

The first run asks at most four questions: register this directory, adopt the models your
subscriptions expose, and whether to accept Antigravity or require a reviewer. It prints everything
it assumed, and every answer can be changed later.

## Everyday commands

| Command | What it does |
|---|---|
| `/use grok` · `/use anthropic/claude-sonnet-5` | Send the next work to this worker. The goal is unchanged. |
| `/auto` | Return to automatic routing. |
| `/why` | Show who won the last route and why the others were set aside. |
| `/goal` | Show established findings, disputed claims and open questions. |
| `/policy direct\|worktree` | Choose whether writes happen in your workspace or in an isolated worktree. |
| `/review on` | Require a reviewer on every write. |
| `/promote <n> --evidence <file>` | Turn a proposal into project memory, with evidence. |

Ctrl+C while a provider is working cancels that task and records it as interrupted. The full
command set is in the [guide](docs/GUIDE.md#interactive-session).

## Providers

| Provider | CLI | Today |
|---|---|---|
| Anthropic Claude Code | `claude` | read and write |
| OpenAI Codex | `codex` | plan, review, judge after an isolation self-test; writes once you score it |
| xAI Grok Build | `grok` | plan, review, judge after a sandbox self-test; writes once you score it |
| Google Antigravity | `agy` | plan, review, judge after you accept its risk |
| GitHub Copilot | `copilot` | read only |

A provider is only used for a role it has earned, by a self-test on each run or by your explicit
acceptance. Run `braingate providers list` to see what yours may do and why. Details:
[How a provider earns a role](docs/GUIDE.md#how-a-provider-earns-a-role).

## Status

BrainGate is a **technical preview**. CI runs on Linux and macOS; Windows is not supported yet. Expect rough edges, and please
[open an issue](https://github.com/Akadoorah/BrainGate/issues) when you hit one.

## Learn more

| | |
|---|---|
| [Full guide](docs/GUIDE.md) | every command, policy, flag and boundary |
| [Architecture](docs/ARCHITECTURE.md) | how the pieces fit together |
| [Security](docs/SECURITY.md) | the boundaries and why they hold |
| [Architecture decisions](docs/adr) | 22 ADRs: the reasoning behind each design choice |
| [Provider policy audit](docs/PROVIDER_POLICY_AUDIT.md) | exactly how each CLI is invoked |
| [Contributing](CONTRIBUTING.md) | running the tests, and when a change needs an ADR |

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
