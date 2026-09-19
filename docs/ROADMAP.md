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

## Milestones 14-18 — Every subscription at its strongest

Through M13 the control plane is complete, but four of the six router roles have exactly one
provider that can fill them, `coder` among them. These milestones open the provider surface
underneath the router so capability routing has something to choose between:

- **M14 — Contracts and capability probes.** ✅ Native structured-output schemas per CLI, stdin for
  Antigravity, and a dated zero-model-call capability probe so profile constants stop being
  hand-written facts that rot.
- **M15 — Tool grants earned per role.** ✅ Replace the fixed per-provider `guarantees` record with
  a grant negotiated per role and proven by attestation. See ADR 0010 (proposed).
- **M16 — More than one provider can write.** ✅ Grok and Codex coder roles behind the same
  worktree/fingerprint/diff-guard/human-merge outcome checks that protect the Claude write path.
- **M17 — Subagents as a routing primitive.** ✅ The router selects a team shape — a lead plus
  BrainGate-defined subagents whose grants are a subset of the lead's — bounded by the existing
  budget governor.
- **M18 — Antigravity readmitted, and terminal parity.** ✅ Re-measured isolation, streaming output,
  resumable per-project sessions, and a receipt naming which provider did which step.

All four subscriptions fill planning, review and judging; Grok and Codex can hold the executing
role once the operator scores them for it; a T4 task plans on two independent subscriptions at
once; and the terminal writes the answer as the model writes it. What is not built is streaming
for the two providers whose stream shape has not been watched, and a review contract has no prose
field to stream.

Full plan, measured provider evidence, and sequencing: [`MULTI_MODEL_PLAN.md`](MULTI_MODEL_PLAN.md).

## Milestones 19-20 — Truth, and a goal above the task

Two milestones that exist because dogfooding found them, not because a plan predicted them.

- **M19 — Run integrity and truth.** ✅ Three vocabularies that had been one (ledger state, operator
  outcome, review status) were separated and derived from exported runtime lists; a run's record is
  written as a fixed sequence of idempotent steps that `tasks reconcile` completes from any prefix;
  usage values are labelled `native`, `measured`, `estimated` or `unknown`, and only a provider's own
  statement may set a quota state (ADR [0012](adr/0012-quota-state-is-native-only.md)).
- **M20 — Native CLI control plane and shared goal context.** ✅ in two slices.
  - **M20.1 — Conversation and Goal above Task.** A conversation and a goal became first-class
    persistent entities in the project's own `goals.sqlite`; a task became a work unit of a goal;
    goal state carries accepted, secondary and *disputed* findings, and a worker's contrary claim is
    recorded beside an accepted one rather than replacing it. A follow-up inherits the complexity of
    the goal it continues, and every worker is handed a bounded handoff built from that state.
  - **M20.2 — Native session continuity and manual switching.** A provider-session registry records
    `Goal ↔ runtime session` references with a resume mode that must be stated; a capability probe
    decides per build whether a session may be named at all; a returning worker is given only what
    changed while it was away; `/use`, `/auto`, `/worker` and `--fresh` switch workers without
    losing the goal. ADR [0014](adr/0014-native-runtime-preservation.md) states the principle behind
    all of it: the native runtime is the default execution mechanism, and BrainGate coordinates it
    rather than replacing it.
  - **M20.3 — Workspace identity, and Git as metadata.** A project gained workspaces: the identity of
    a workspace is its canonical path, `braingate init` registers a plain directory, a subdirectory of
    a repository, or a repository — Git is recorded as evidence (`gitRoot`, branch, `HEAD`, remote)
    and decides nothing. The provider's `cwd`, the attachment refusal and `/project` speak in
    workspaces now, and every command resolves the same binding through one implementation. ADR
    [0015](adr/0015-workspace-identity.md).
  - **M20.4 — Workspace-scoped execution state and goal binding.** Every store that describes local
    execution moved to `<home>/projects/<projectId>/workspaces/<workspaceId>/`: the task ledger,
    conversations and goals, the dogfood corpus, results and evidence, snapshots, worktrees and the
    session thread. A goal records the workspace it belongs to and refuses by id when it is not this
    one; a provider session is bound to project, workspace, goal, provider and model, so continuing
    the same work elsewhere is a handoff and a fresh session rather than a native resume. Durable
    knowledge stayed project-scoped, and memory refuses a workspace handle. State written before
    workspaces existed is preserved read-only, never read and never migrated on a guess. ADR
    [0016](adr/0016-workspace-scoped-execution-state.md). Still open, and next: the DIRECT/NATIVE
    execution mode that makes a write in a workspace with no repository possible without a worktree,
    and an explicit import tool for legacy state if one is ever wanted.

  - **M20.5 — DIRECT/NATIVE workspace execution.** Execution policy became a first-class, chosen
    concept — `direct`, `read-only`, `worktree`, `snapshot`, `unattended` — with DIRECT as the
    ordinary interactive boundary: the native CLI runs in the selected workspace, shares the
    filesystem with every other worker, leaves its changes there and commits nothing. Intent decides
    what is wanted and can only narrow the boundary; the strict modes are unchanged and are selected
    explicitly; and the workspace-change guard works with or without Git. Under DIRECT the Claude
    invocation stops substituting BrainGate's tool allowlist, MCP refusal and declared subagents for
    the CLI's own harness, and the plan's guarantees are updated to what the argv actually earns.
    Grok, Codex and Antigravity refuse DIRECT with a named reason rather than running under an
    unmeasured boundary. ADR [0017](adr/0017-direct-execution.md). Next: re-measuring those three
    invocations against the installed builds, and an explicit commit workflow.

## Milestone 21 — Native multi-provider DIRECT control plane ✅

Re-measured the DIRECT invocation for Codex, Grok and Antigravity against the installed builds and
opened DIRECT writes for all three, not only Claude. Native session continuity now covers every
runtime that reports its own session id, and one goal is reachable across all four providers rather
than three. Codex's DIRECT read gained the external schema it needs; Antigravity's DIRECT path was
found blocked by its own headless tool denial and marked so rather than assumed open — the
measurement M22 later acted on.

## Milestone 22 — Every installed CLI runs DIRECT ✅

Closed what M21 found blocked: Antigravity DIRECT now reads its own settings
(`~/.gemini/antigravity-cli/settings.json`) to decide whether headless reads and shell commands are
allowed, rather than being closed by default (ADR
[0020](adr/0020-antigravity-direct-is-read-from-its-own-settings.md)) — BrainGate reads that file
and never writes it. The execution-policy gate now applies to every role a task plans, not only the
primary, and routing considers the task, the chosen policy, and the goal's own native sessions
together rather than the task alone. The Arabic real-run harness that has found every real defect so
far found and fixed the ones the fakes hid here too (`memory/fakes-prove-intent-not-outcome`).

## Milestone 23 — First run in ten minutes, and every weakness closed

The operator's own list of what still made BrainGate a demo rather than a daily tool, after M22 —
executed as one phase per PR, Opus for the hard phases and Sonnet for CLI/UX/docs, a real Arabic
session gating each one. Full plan: `docs/adr/0021-big-writes-and-default-profiles.md` and the
milestone's own plan document.

- **M23-A — First run in ten minutes.** ✅ (merged) Default model capability profiles per known
  model family, adopted only on the operator's say-so and never overwriting a score the operator
  set; a four-question setup wizard (register, adopt, accept Antigravity where relevant, reviewer
  policy) that replaces hand-authoring a model-catalog JSON entry before BrainGate can do anything;
  workspace-scoped session preferences (`policy`, `reviewAlways`) kept beside the thread rather than
  in the identity manifest.
- **M23-B — Big writes escalate, never refused, never DIRECT.** ✅ (merged) A T3/T4 or
  high/critical-risk write no longer fails outright: asked for DIRECT it escalates to an isolated
  worktree with a cross-provider-only reviewer, and it is refused by name only when no second
  provider is signed in — never run unreviewed, never in the operator's checkout. ADR
  [0021](adr/0021-big-writes-and-default-profiles.md).
- **M23-C — Nothing is silent while a provider works.** ✅ (merged) Codex and Antigravity streaming
  dialects, measured against real runs and dated; the REPL's working indicator names the provider
  and elapsed time.
- **M23-D — The route explains itself, quota state is visible.** Complete, pushed
  (`feat/m23-d-why-and-quota`), not yet merged to `main`. `/why` shows the last plan's route per
  role — the winner's own reasons and every rejected candidate's; active refusal backoffs are shown
  as BrainGate's own decision, never a provider limit (ADR
  [0012](adr/0012-quota-state-is-native-only.md)); refusals in the session collapse to one line
  with the full text still behind `--json`.
- **M23-E — Fewer keystrokes.** Complete, pushed (`feat/m23-e-fewer-keystrokes`), not yet merged.
  `/use grok|claude|codex|antigravity` provider aliases; Up/Down request history on an empty
  composer line; "did you mean" for a near-miss slash command; `/promote <n> --evidence <file>`;
  Ctrl+C cancels the running task instead of exiting the session.
- **M23-F — Ship a technical preview.** Complete, pushed (`feat/m23-f-technical-preview`), not yet
  merged, dated 2026-09-19. `apps/cli` gained a `build` script (esbuild, `better-sqlite3` kept
  external) and a `pnpm pack` tarball proven with a real `npm install -g` smoke test under a
  throwaway `HOME`; the README was rewritten around the ten-minute path with a new "Responsible
  use" section and a current Arabic translation; `docs/PROVIDER_POLICY_AUDIT.md` states exactly how
  BrainGate invokes each of Claude Code, Codex, Grok and Antigravity; `LICENSE` (Apache-2.0),
  `SECURITY.md`, and `CONTRIBUTING.md` were added; a dependency license scan and a Git-history scan
  for secrets and personal data were run and recorded in
  [`docs/PUBLIC_RELEASE_CHECKLIST.md`](PUBLIC_RELEASE_CHECKLIST.md) (the latter surfaced the
  operator's real email in existing pushed commit history, which needs the operator's decision —
  history was not rewritten). This closes the code/docs items in that checklist that did not need a
  legal or business decision; it does not itself make BrainGate publicly released — see that
  document for what remains and why.

Once D, E and F are merged, what M23 leaves open for the next milestone: automated review/council
execution beyond the T4 disagreement path, a web dashboard, and the broader native-capability
overlays ADR 0014 classifies — plus everything `docs/PUBLIC_RELEASE_CHECKLIST.md` still lists as
unchecked.

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
