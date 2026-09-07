# Product definition

BrainGate is a local AI engineering control plane for developers who already subscribe to one or more AI coding products.

The user asks BrainGate a question or requests a change. BrainGate identifies the active project, classifies complexity and risk, retrieves only relevant context, allocates a bounded execution budget, selects an available model role, and records the result.

The long-term product thesis is:

> **One control plane for every AI coding subscription.**

BrainGate itself is deterministic orchestration software, not the model. Provider models are replaceable workers selected according to capability, risk, context, quota evidence, isolation guarantees, and role requirements.

## Primary user experience

The user should not normally need to choose a provider or model. BrainGate exposes intent-oriented commands such as ask, run, review, status, and doctor.

Before medium/high-risk execution BrainGate produces a task brief describing project, classification, planned workers, maximum rounds, skills, permissions, and context budget. After execution it produces a receipt with provider/model roles, files read/changed, tests, retries, usage evidence, reviewer independence, and memory updates.

BrainGate should remain valuable for users with only one provider subscription as well as users with several providers. Multiple models from one provider may fill fast/balanced/deep roles without being misrepresented as independent provider authorities or independent quota pools.

## Product principles

- **Subscription-first:** integrate through official/supported provider tools and the user's independently authorized account session.
- **Local-first core:** ordinary local routing, memory, worktree execution, and receipts should not require BrainGate Cloud.
- **Cheap-first escalation:** select the least expensive/fastest sufficiently capable model and escalate when complexity, risk, disagreement, or evidence requires it.
- **Truthful uncertainty:** quota and usage claims carry provenance instead of being fabricated.
- **Project isolation:** memory, skills, context, execution, and telemetry are project-scoped by default.
- **Safety is a core feature:** project isolation, memory integrity, Secret Guard, worktree boundaries, and auditability should not become commercial-only protections.
- **Human authority:** current high-risk acceptance, merge, deploy, and production decisions remain human-controlled unless a future milestone proves a stronger policy model.

## Open-source product direction

BrainGate Core is intended to become a genuinely useful open-source local developer product. The intended Community edition includes the deterministic core, local CLI/dashboard, memory/context system, routing, provider discovery/adapters, local safe execution primitives, worktree workflows, local observability, and extension contracts.

The current preferred licensing direction is Apache-2.0, but **no final license has been selected merely by documenting this preference**. Licensing, third-party attribution, trademark, contributor policy, and public-release requirements must be explicitly completed before the repository is made public.

See [`OPEN_SOURCE_AND_COMMERCIAL.md`](OPEN_SOURCE_AND_COMMERCIAL.md) for the intended OSS/commercial boundary and [`PUBLIC_RELEASE_CHECKLIST.md`](PUBLIC_RELEASE_CHECKLIST.md) for launch prerequisites.

## Commercial product direction

A future commercial BrainGate product should monetize capabilities that are naturally cross-device, team-oriented, centrally administered, or operationally managed rather than weakening the local open-source core.

Potential commercial areas include:

- BrainGate Cloud;
- encrypted multi-device synchronization;
- remote observation and approvals;
- remote control of a BrainGate worker running on an authorized developer workstation;
- notifications and device management;
- team/project membership and RBAC;
- organization policy distribution;
- centralized fleet/provider/quota observability where provider terms permit it;
- team audit/approval workflows;
- enterprise SSO/compliance/retention/deployment controls;
- managed integrations and support;
- a curated ecosystem/marketplace layer.

A key commercial hypothesis is that **remote control and approval from another authorized device** can become a high-value differentiator while provider credentials and execution remain on the developer's machine.

## Business model boundary

BrainGate should normally operate on a **bring-your-own authorized provider subscription/account** model.

The business must not depend on:

- reselling provider subscription access without an explicit compatible agreement;
- sharing/pooling provider accounts;
- scraping credentials or session tokens;
- private provider endpoints;
- bypassing usage limits;
- silently converting subscription use into API billing;
- uploading provider credentials to BrainGate Cloud merely to coordinate local agents.

The commercial value proposition is coordination, reliability, memory, routing, auditability, remote operation, team administration, and enterprise governance—not resale of model tokens.

## Initial packaging hypothesis

These are validation hypotheses rather than published commitments:

- **Community** — free/open-source local BrainGate.
- **Pro** — optional individual cloud/sync/remote features.
- **Teams** — collaboration, organization policy, administration, shared audit/approval features.
- **Enterprise** — compliance, security policy, deployment, support, and contractual features.

Early pricing hypotheses for research purposes are approximately $12–15/month for Pro, $25–29/user/month for Teams, and $12k–25k+/year for Enterprise depending on scope. Architecture must not be optimized around these preliminary numbers.

## Product moat hypothesis

No single routing algorithm is expected to be defensible by itself. A stronger moat can emerge from the accumulated system:

- provider compatibility and versioned safety knowledge;
- routing and quota telemetry;
- long-lived canonical project memory quality;
- project/skill isolation reliability;
- adversarial regression corpus;
- provider-independent task receipts;
- extension/provider ecosystem;
- trusted remote approval/control experience;
- enterprise policy integrations.

The moat is expected to be **reliability + compatibility data + memory quality + ecosystem**, not merely the existence of an orchestrator.

## Non-goals for v1

- Re-selling model access.
- Sharing provider accounts or credentials.
- Autonomous production deployment.
- Automatic merging to protected branches.
- Always-on councils or swarms.
- Requiring a BrainGate cloud account for ordinary local workflows.
- Weakening safety controls to manufacture a paid tier.

Cloud sync, remote control, teams, marketplace, and enterprise capabilities are future product layers, not requirements for the current local dogfood release.
