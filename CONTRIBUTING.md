# Contributing

BrainGate is a founder/maintainer-led technical preview (see
[`docs/OPEN_SOURCE_AND_COMMERCIAL.md`](docs/OPEN_SOURCE_AND_COMMERCIAL.md)). This file covers how
to run the project, the rule that has found more real defects than anything else in review, and
when a change needs an ADR instead of just a pull request.

## Running it

```bash
git clone https://github.com/Akadoorah/BrainGate.git
cd BrainGate
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

`pnpm test` runs the full hermetic suite — no provider CLI is called, and nothing under
`~/.braingate` or another CLI's own settings is touched. It proves BrainGate's own logic, not that
an installed provider CLI agrees with it.

```bash
pnpm test:integration
```

This drives real provider CLIs against a throwaway repository and spends real subscription quota.
It never runs in CI and is not required for most changes; see [`docs/DOGFOOD.md`](docs/DOGFOOD.md).

## The real-run rule

Every fake executor in this codebase is a copy of an assumption about a provider CLI, not a test of
one. A green suite proves BrainGate did what it was written to do; it does not prove the CLI agrees.
Per `AGENTS.md`:

> Run a provider-facing change against the real CLI once before calling it done. A single manual
> run has repeatedly found what the suite could not.

If your change touches how BrainGate invokes `claude`, `codex`, `agy` or `grok` — a new flag, a
different output-parsing path, a new streaming dialect — run it for real, on the installed build,
before opening the PR. State what you measured and when, the same way the code comments in
`packages/shadow/src/profiles.ts` do: a provider fact is a dated measurement, not a standing truth,
because these CLIs ship weekly.

## Before you open a PR

- Read `AGENTS.md` — it is the canonical instruction file for anyone working in this repository,
  human or agent, and states the non-negotiable invariants (project isolation, no credential
  scraping, no hard-coded provider names in routing policy, and more).
- Read the ADRs relevant to what you're touching (`docs/adr/`). If your change conflicts with an
  accepted one, that's a discussion before it's a diff — open an issue or start the PR description
  with the conflict rather than quietly working around it.
- A new architectural decision — not a bug fix, not an extension of an existing contract — needs a
  new ADR. Look at an existing one for the shape: context, the decision, what it amends, the
  consequences.
- Keep changes scoped. A PR that fixes one thing and refactors three unrelated things is harder to
  review and harder to revert if it's wrong.
- Never commit a capability score, a provider acceptance, or quota history on the operator's
  behalf without saying so in the PR description — `~/.braingate` is their data (ADR
  [0008](docs/adr/0008-operator-accepted-providers.md), `docs/PROVIDER_DISCOVERY.md`).
- Tests should prove project isolation, permission enforcement, and routing behavior where the
  change touches any of those, not just the happy path.

## Reporting a security issue

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).
