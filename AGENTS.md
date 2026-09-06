# BrainGate agent instructions

These rules apply to every coding agent working in this repository.

## Before editing

1. Read `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.
2. Read all accepted ADRs relevant to the change.
3. Keep changes inside the requested milestone or issue.
4. Do not redesign public interfaces unless the current requirement cannot be met safely.

## Non-negotiable invariants

- Never implement token scraping, credential extraction, or private-provider endpoint access.
- Never persist provider access tokens, passwords, API keys, `.env` contents, or production secrets.
- Project-scoped data must never be retrieved across project boundaries by default.
- Canonical memory must have a single validated write path.
- Provider/model names must not be hard-coded into core routing policy.
- Council/multi-agent execution is opt-in by policy, not the default.
- Agents must not write directly to a registered project's primary checkout.
- Usage values must be labelled `native`, `measured`, `estimated`, or `unknown`; estimated values must never be presented as authoritative.

## Engineering standards

- Prefer small modules with explicit interfaces.
- Core domain logic must be deterministic and testable without installed provider CLIs.
- Provider-specific behavior belongs under provider adapters.
- Security boundaries require tests, not prompt-only instructions.
- New architectural decisions require an ADR.

## Definition of done

A change is complete only when relevant tests pass, scope remains focused, security invariants are preserved, and the final diff contains no secrets or unrelated changes.
