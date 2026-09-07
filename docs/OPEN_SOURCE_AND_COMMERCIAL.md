# Open-source and commercial strategy

> Status: product strategy and architectural intent. This document is **not** a software license, trademark clearance, pricing commitment, or legal opinion. Final public-release licensing and brand decisions require an explicit review before the repository is made public.

## Product thesis

BrainGate should become a useful open-source local AI engineering control plane first, with optional commercial products built around collaboration, remote operation, organization management, encrypted synchronization, and enterprise controls.

The core promise is:

> **One control plane for every AI coding subscription.**

BrainGate does not sell model intelligence. It coordinates AI coding products that users are independently authorized to use.

The open-source product must remain valuable on its own. Commercial features should add multi-device, team, fleet, administration, compliance, convenience, and managed-service value rather than intentionally crippling the local core.

## Open-source core

The intended Community/Open Source edition should include the capabilities required to run BrainGate locally as a serious developer tool:

- project registry and deterministic project isolation;
- task classification and Budget Governor;
- canonical project memory and bounded context building;
- memory bootstrap/import proposal flow;
- model/provider registry and capability-based routing;
- quota state/provenance contracts;
- provider discovery and community provider adapters;
- local subscription-authenticated provider execution where safely supported;
- worktree-only write execution and verification primitives;
- reviewer/judge workflow contracts and graded reviewer independence;
- Skills Firewall and project-scoped skill loading;
- Secret Guard and local execution safety boundaries;
- local task ledger, receipts, audit events, and dogfood telemetry;
- local CLI and local observability/dashboard;
- regression tests and provider compatibility probes;
- documented extension points for providers, skills, isolation backends, and local tools.

The Community edition should not require BrainGate Cloud to route tasks, read canonical local memory, execute supported local providers, create worktrees, verify changes, or inspect local receipts.

## Commercial layer

A future commercial BrainGate product may provide optional services that are naturally cross-device, multi-user, centrally administered, or operationally expensive to run.

Potential paid capabilities include:

### BrainGate Cloud

- encrypted synchronization of selected BrainGate state;
- device registration and secure relay;
- remote task observation;
- remote approval/rejection of local agent actions;
- remote control from phone, tablet, browser, or another workstation;
- notification delivery;
- managed backup/recovery for explicitly synchronized BrainGate metadata;
- cloud-hosted coordination services that do not require provider credential custody.

A high-value product direction is **remote control and approval of BrainGate running on a developer workstation from another authorized device**.

### Pro

Potential individual paid features:

- encrypted multi-device sync;
- remote approvals and notifications;
- richer historical analytics;
- optional managed compatibility feeds;
- convenience features around remote access and device management.

### Teams

Potential team features:

- shared organization policies;
- role-based access control;
- team/project membership;
- centralized provider/quota observability where provider terms permit it;
- shared approved engineering conventions and organization memory layers;
- review/approval workflows;
- shared audit views;
- organization skill registries;
- managed policy distribution;
- team device administration.

### Enterprise

Potential enterprise features:

- SSO/SAML/OIDC and, where justified, SCIM;
- organization-wide policy enforcement;
- compliance/audit exports;
- retention and residency controls;
- enterprise deployment patterns;
- centralized fleet health and version policy;
- private integration management;
- advanced security controls;
- support, onboarding, and contractual SLAs;
- optional self-hosted commercial control-plane components.

### Marketplace/ecosystem

A future curated skill/provider/integration marketplace may be commercialized through managed distribution, verification, discovery, support, or revenue sharing. The basic ability to build and load local/community integrations should remain available in the open-source core.

## What BrainGate must not monetize by weakening

The commercial model should not depend on making the open-source edition unsafe or intentionally incomplete.

The following should remain core product principles rather than paywalls:

- project isolation;
- canonical-memory integrity;
- basic Secret Guard protections;
- truthful quota provenance;
- deterministic routing primitives;
- worktree-only local safety boundaries;
- local receipts/auditability;
- provider-policy compliance;
- the ability to use supported local provider subscriptions without BrainGate Cloud.

Commercial value should come from coordination, management, scale, convenience, enterprise governance, and managed services.

## Provider and billing boundary

BrainGate must not build its business model around unauthorized provider access.

Unless a provider explicitly offers a compatible commercial arrangement, BrainGate should not:

- resell provider subscription access;
- pool or share user accounts;
- scrape OAuth/session tokens;
- custody provider passwords;
- call private/unsupported endpoints;
- circumvent provider usage limits;
- disguise API billing as subscription use;
- represent one provider subscription as multiple independent quota authorities without evidence.

The default commercial assumption is **bring your own independently authorized provider account/subscription**.

Provider-specific integrations must continue to use documented/supported authentication and execution boundaries, and compatibility may be disabled when a provider CLI cannot enforce BrainGate's required safety profile.

## Licensing direction

The current preferred direction for the open-source core is a permissive license, with **Apache License 2.0** as the leading candidate because it is business-friendly and includes an explicit patent grant.

No license should be added solely because this document names a preference. Before public launch, BrainGate needs an explicit licensing decision that considers:

- all repository dependencies and generated artifacts;
- code or patterns adapted from external projects;
- required notices and attribution;
- patent implications;
- contributor licensing strategy;
- compatibility with future commercial modules;
- package/release distribution.

Until a repository license is deliberately selected and added, no document should imply that the source has already been released under Apache-2.0 or any other license.

## Source boundary between OSS and commercial code

The architecture should preserve a clean dependency direction:

```text
commercial/cloud/team layers
        ↓ depend on stable contracts
open-source BrainGate core
        ↓
provider CLIs / Git / local OS primitives
```

The open-source core must not import or require proprietary cloud modules to function locally.

Preferred seams include explicit interfaces/events for:

- remote control transports;
- synchronization backends;
- identity/organization providers;
- organization policy sources;
- notification transports;
- audit export sinks;
- managed compatibility metadata;
- team approval services.

Commercial implementations can implement those interfaces without moving the local routing, memory, isolation, or execution fundamentals out of the open-source core.

Cloud absence or outage should not prevent local Community workflows that do not intrinsically require cloud coordination.

## Data ownership and privacy

A commercial BrainGate service should preserve the local-first trust model.

Default principles:

- provider credentials remain on the user's authorized device whenever technically possible;
- BrainGate Cloud should not need provider access tokens merely to relay approvals or synchronize BrainGate metadata;
- synchronization must be opt-in and explicit about which data classes leave the device;
- secrets and raw provider reasoning should not become cloud telemetry by default;
- telemetry used for product improvement should be separately consented to and documented;
- enterprise retention/residency policies must not silently weaken local Secret Guard or project-isolation rules.

Encryption and key-management design for cloud sync is a future security milestone and must be reviewed independently before claiming end-to-end encryption.

## Packaging and repository direction

A likely future repository/product boundary is:

```text
BrainGate OSS repository
├── deterministic core
├── local CLI
├── local dashboard
├── memory/context/routing
├── provider adapters
├── worktree/execution safety
├── local observability
├── extension SDK/contracts
└── community integrations

Commercial products/services
├── BrainGate Cloud
├── remote relay/control
├── encrypted sync
├── team/org administration
├── enterprise policy/compliance
├── fleet management
└── managed integrations/support
```

This is a product boundary, not a requirement that all commercial code live in a separate repository immediately. Before public release, package dependency rules should make the boundary mechanically testable.

## Contribution and governance direction

Before the project becomes public, decide and document:

- maintainer/owner model;
- contribution review expectations;
- whether to use Developer Certificate of Origin (DCO), a Contributor License Agreement (CLA), or neither;
- CODEOWNERS and security-sensitive ownership;
- release/versioning policy;
- compatibility/support windows;
- provider-adapter acceptance criteria;
- process for architectural decisions;
- process for deprecating unsafe provider integrations.

The initial public project can reasonably remain founder/maintainer-led. Governance should become more formal only as contributor count and ecosystem risk justify it.

## Trademark and naming

The code license and the BrainGate brand are separate concerns.

Before public launch:

- perform name/trademark clearance in relevant markets;
- decide what uses of the BrainGate name/logo are permitted for forks and third-party services;
- publish a trademark policy if the project develops a significant ecosystem;
- avoid implying endorsement by Anthropic, OpenAI, Google, xAI, GitHub, or other provider companies merely because their tools are supported.

Provider names should be used descriptively and in accordance with applicable trademark and integration guidelines.

## Pricing hypotheses

Pricing is not finalized and must not drive architecture prematurely.

Current hypotheses for future validation are approximately:

| Tier | Product hypothesis | Early pricing hypothesis |
| --- | --- | --- |
| Community | Open-source/local BrainGate | Free |
| Pro | Individual cloud/sync/remote features | ~$12–15/month |
| Teams | Collaboration, administration, shared policy | ~$25–29/user/month |
| Enterprise | Compliance, policy, deployment, support | ~$12k–25k+/year depending on scope |

These numbers are research hypotheses, not published prices or commitments.

The primary pricing question is not "how much intelligence can BrainGate resell?" It is "how much operational value does BrainGate create by safely coordinating intelligence the customer already pays for?"

## Go-to-market sequence

### Phase 1 — Private dogfood

- use BrainGate across real internal projects;
- measure routing correctness and quota savings;
- harden provider compatibility;
- turn failures into regression tests;
- prove that memory and project isolation remain reliable over time.

### Phase 2 — Public technical preview

Prerequisites:

- final OSS license;
- third-party license/attribution audit;
- install/onboarding path that works from a clean machine;
- public security policy and threat model;
- supported-platform matrix;
- contribution/community files;
- release/versioning process;
- no private credentials/history/test artifacts in Git history;
- provider-policy review.

Focus on developers who already pay for one or more AI coding subscriptions and want routing, memory, safety, and auditability without surrendering provider credentials to another AI API aggregator.

### Phase 3 — Community growth

- stabilize provider adapter contracts;
- enable community skills/integrations;
- publish compatibility matrices;
- build public regression data where privacy permits;
- develop an ecosystem around safe provider orchestration.

### Phase 4 — Commercial beta

Introduce paid value only after the OSS local product proves useful:

- remote control/approval;
- encrypted multi-device state;
- managed notifications;
- team policy/approval workflows;
- centralized organizational observability.

### Phase 5 — Enterprise

Add governance/compliance/deployment features where customers demonstrate demand rather than front-loading enterprise complexity into the local core.

## Moat hypothesis

Individual components are copyable. The stronger moat can emerge from accumulated reliability and ecosystem depth across:

- provider compatibility knowledge and versioned safety profiles;
- routing telemetry showing which model capability classes work for which tasks;
- quota-aware scheduling behavior;
- long-lived canonical project memory quality;
- project/skill isolation and execution reliability;
- provider-independent receipts and audit semantics;
- adversarial regression corpus;
- community provider/skill ecosystem;
- trusted remote approval/control UX;
- enterprise policy integration.

The moat is therefore expected to be **operational reliability + compatibility data + memory quality + ecosystem**, not a single routing formula.

## Success metrics

### OSS health

Useful measures include:

- successful clean-machine installs;
- weekly active local projects;
- task success rate;
- provider compatibility coverage;
- routing misclassification rate;
- regressions caught before release;
- community contributions/adapters;
- time to recover from provider CLI breaking changes.

### Commercial health

Useful future measures include:

- conversion from active OSS users to optional paid services;
- remote approval/control usage;
- retained synchronized devices/projects;
- team adoption and seat expansion;
- enterprise renewal/support load;
- cloud gross margin independent of model-token resale.

## Decisions required before public launch

The following are intentionally **not yet final**:

1. final repository license;
2. trademark/name clearance;
3. DCO vs CLA vs no contributor agreement;
4. exact OSS/commercial package boundary;
5. public telemetry defaults;
6. release/versioning and support policy;
7. hosted/cloud architecture and encryption model;
8. final pricing;
9. marketplace economics;
10. enterprise deployment model.

Those decisions should be made with evidence from dogfood and an independent repository/product audit rather than being silently inferred from implementation details.
