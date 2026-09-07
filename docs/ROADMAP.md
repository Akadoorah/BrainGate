# Roadmap

## Milestone 0 — Foundation ✅

Architecture, security boundaries, ADRs, repository conventions, and minimal monorepo scaffold.

## Milestone 1 — Project and task core ✅

Project Registry, immutable project IDs, SQLite storage, Task Ledger, event model, and deterministic task lifecycle.

## Milestone 2 — Classification and budgets ✅

Complexity/risk classifier, escalation/de-escalation, Budget Governor, loop caps, and policy tests.

## Milestone 3 — Provider discovery ✅

Official CLI discovery for Claude Code, Codex, Antigravity, Grok Build, and optional GitHub Copilot CLI; install/version/model discovery and normalized telemetry. Discovery is zero-prompt and never intentionally consumes model tokens or AI credits.

## Milestone 4 — Context and memory ✅

Bounded project retrieval, context packs, canonical memory validation, retention policy, and project-level physical isolation.

## Milestone 5 — Safe execution ✅

Skill Firewall, Secret Guard, Git worktrees, process permissions, read/write execution profiles, and verification hooks.

## Milestone 6 — Routing and review ✅

Capability-based model routing, primary/reviewer workflows, bounded repair, disagreement detection, and optional council/judge.

## Milestone 7 — Dashboard and observability ✅

Task briefs, execution status, task receipts, audit events, provider quota telemetry, and native/measured/estimated/unknown usage labels.

## Milestone 8 — Shadow dogfood foundation ✅

Read-only provider invocation profiles, project-CWD enforcement, subscription environment sanitization, bounded provider output, and no-session-persistence paths.

## Milestone 9 — Local operator CLI and model catalog ✅

Persistent scored model catalog, truthful runtime hydration, `doctor`/`discover`/`models`/`shadow`/`status`/`dashboard`, sanitized plans, and explicit `--execute` gating for provider model calls.

## Milestone 10 — Hardened Codex reviewer ✅

ChatGPT-authenticated Codex as an independent reviewer only, with role-scoped routing, a clean staged workspace, a zero-model-call sandbox self-test, version/platform/profile-bound isolation attestations, explicit tool/feature denial, and fail-closed native Windows handling.

## Milestone 11 — Worktree-only write dogfood ✅

Restricted Claude worktree writes, guarded diffs, source-checkout invariants, verification, reviewer gating, explicit `--execute`, and human-only merge semantics. High/critical and T3/T4 writes remain blocked.

## Milestone 12 — Real-project dogfood and adaptive routing ✅

Local project onboarding, zero-model-call preflight, real `ask`/small-write dogfood flows, project-scoped append-only experiment telemetry, user feedback/report/export commands, deterministic sanitized regression metadata, and conservative project/mode routing priors that can only escalate after sufficient evidence.

The first supported rollout is intentionally manual and local. Model capability definitions remain user-verified, provider sessions remain local, and BrainGate still has no automatic merge/push/deploy surface.

## Next hardening

- Grow the labeled regression corpus across Waslo, SaudiGPT, Viral-X, and Tabaq AI.
- Measure routing/classification error rates and quota pressure on real work.
- Convert every isolation/routing/memory/quota failure into a deterministic regression test.
- Add bounded project test-command policies before widening write scope beyond simple T0-T2 changes.
- Harden additional provider execution paths only where equivalent isolation can be proven.

## Later

Hardened Antigravity/Grok execution paths, visual/image workers, visual QA, remote control, encrypted sync, teams, plugin/skill marketplace, and enterprise policy features.
