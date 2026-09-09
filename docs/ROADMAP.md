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

## Milestone 13 — Memory bootstrap and single-provider routing ✅

Pre-trial hardening for users with existing project history or only one AI subscription provider:

- local Markdown/text, normalized JSONL, and compact best-effort ChatGPT conversation-export bootstrap;
- import preview with no persistence;
- proposal-only historical memory import with canonical dedupe;
- explicit evidence/confidence required before canonical promotion;
- capability-based routing across multiple models from one provider without hard-coded model names;
- reviewer independence tiers: cross-provider, same-provider/different-model, same-model/fresh-session;
- shared quota-pool visibility rather than treating models from one subscription as separate providers;
- critical tasks remain cross-provider fail-closed, while noncritical T4 same-provider review remains human-approval gated;
- `braingate models profile` reports T0-T4 model coverage and reviewer independence.

## Milestones 14-18 — Every subscription at its strongest (planned)

Through M13 the control plane is complete, but four of the six router roles have exactly one
provider that can fill them, `coder` among them. These milestones open the provider surface
underneath the router so capability routing has something to choose between:

- **M14 — Contracts and capability probes.** Native structured-output schemas per CLI, stdin for
  Antigravity, and a dated zero-model-call capability probe so profile constants stop being
  hand-written facts that rot.
- **M15 — Tool grants earned per role.** Replace the fixed per-provider `guarantees` record with
  a grant negotiated per role and proven by attestation. See ADR 0010 (proposed).
- **M16 — More than one provider can write.** Grok and Codex coder roles behind the same
  worktree/fingerprint/diff-guard/human-merge outcome checks that protect the Claude write path.
- **M17 — Subagents as a routing primitive.** The router selects a team shape — a lead plus
  BrainGate-defined subagents whose grants are a subset of the lead's — bounded by the existing
  budget governor.
- **M18 — Antigravity readmitted, and terminal parity.** Re-measured isolation, streaming output,
  resumable per-project sessions, and a receipt naming which provider did which step.

Full plan, measured provider evidence, and sequencing: [`MULTI_MODEL_PLAN.md`](MULTI_MODEL_PLAN.md).

## Immediate technical hardening

- Grow the labeled regression corpus across Waslo, SaudiGPT, Viral-X, and Tabaq AI.
- Measure routing/classification error rates and quota pressure on real work.
- Convert every isolation/routing/memory/quota failure into a deterministic regression test.
- Add bounded project test-command policies before widening write scope beyond simple T0-T2 changes.
- Harden additional provider execution paths only where equivalent isolation can be proven.

## Open-source release track

BrainGate Core is intended to become a useful open-source local product rather than a crippled demonstration edition.

Before a public technical preview:

- select and add the final OSS license; Apache-2.0 is the current preferred direction, not yet a granted license;
- complete third-party code/license/attribution review;
- perform BrainGate name/trademark clearance;
- add contribution/governance/community artifacts;
- publish a vulnerability disclosure policy and supported-platform/provider matrix;
- create a clean-machine installation/upgrade path;
- define release/versioning/package publishing;
- verify that Git history contains no private dogfood data, credentials, exports, or personal information;
- run platform/provider-policy audits;
- mechanically preserve the dependency boundary where optional commercial/cloud layers depend on OSS contracts rather than the OSS core depending on proprietary services.

See [`OPEN_SOURCE_AND_COMMERCIAL.md`](OPEN_SOURCE_AND_COMMERCIAL.md) and [`PUBLIC_RELEASE_CHECKLIST.md`](PUBLIC_RELEASE_CHECKLIST.md).

## Commercial product track

Commercial development should start only after the local OSS product proves recurring utility in real dogfood.

### Commercial beta candidates

- BrainGate Cloud account/device layer;
- secure remote relay and notifications;
- remote observation and approval/control from another authorized device;
- encrypted selected-state synchronization after a dedicated security design/review;
- richer managed compatibility/analytics services;
- team membership, RBAC, organization policies, and approval workflows;
- centralized team/fleet observability where provider policies allow it.

### Enterprise candidates

- SSO and organization identity integration;
- compliance/audit exports;
- retention/residency controls;
- enterprise deployment/self-hosted commercial components where justified;
- managed integrations;
- support/onboarding/SLAs;
- advanced fleet and version policy.

### Marketplace/ecosystem candidates

- curated distribution and verification of provider adapters, skills, and integrations;
- optional commercial discovery/support/revenue-sharing layers while preserving community extension capability in the OSS core.

Commercial features must not require provider credential pooling, token scraping, private endpoints, subscription resale, or usage-limit circumvention. The default model remains bring-your-own independently authorized provider account/subscription.

## Packaging hypotheses

These are validation hypotheses rather than public commitments:

- **Community** — free/open-source local BrainGate.
- **Pro** — optional individual cloud/sync/remote functionality.
- **Teams** — collaboration, policy, administration, and shared audit/approval functionality.
- **Enterprise** — compliance, security policy, deployment, support, and contractual capabilities.

Early research pricing hypotheses remain roughly $12–15/month for Pro, $25–29/user/month for Teams, and $12k–25k+/year for Enterprise depending on scope. Product architecture must not be optimized around these numbers before customer evidence exists.

## Later technical/product directions

Hardened Antigravity/Grok execution paths, visual/image workers, visual QA, remote control, encrypted sync, teams, plugin/skill marketplace, enterprise policy features, and broader platform support.
