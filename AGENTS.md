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
- A string-literal union that anything validates or enumerates must be derived from an exported
  runtime list, so the type and the check cannot drift apart.

## Working with provider CLIs

The boundary between BrainGate and a provider CLI is where the assumptions live, and a fake
executor is a copy of the assumption rather than a test of it. A green suite proves the code does
what it was written to do; it does not prove the provider agrees.

- Run a provider-facing change against the real CLI once before calling it done. Opt-in
  integration tests exist (`BRAINGATE_INTEGRATION=1`), and a single manual run has repeatedly
  found what the suite could not.
- A recorded provider limitation is a measurement with a date, not a standing fact. These CLIs
  ship weekly, and a refusal built on a stale finding costs the operator a subscription they pay
  for. Re-measure before writing or citing one.
- Bind an attestation to the CLI version, the platform, and a hash of the policy it was earned
  under, so a change to any of them invalidates it without anyone remembering to.
- Do not ask a provider for something it cannot know. Where a value is chosen by the CLI rather
  than the model — a generated file's path, for instance — discover it instead of prompting for
  it.

## The operator's own state

`~/.braingate` holds the model catalogue, provider acceptances, and quota history. These decide
what runs, at what cost, and what risk the operator has accepted.

- Never add a capability score, an acceptance, or simulated usage on the operator's behalf
  without saying so in the same message, and revert it afterwards.
- The quota store is append-only by design; nothing written there can be taken back.

## Definition of done

A change is complete only when relevant tests pass, scope remains focused, security invariants are preserved, and the final diff contains no secrets or unrelated changes.
