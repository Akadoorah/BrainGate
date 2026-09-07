# Public release readiness checklist

This checklist tracks work required before BrainGate changes from a private pre-alpha repository to a public open-source project.

A checked item should mean the artifact or control actually exists and has been reviewed. This document intentionally distinguishes product intent from release readiness.

## Legal and licensing

- [ ] Select and add the final repository `LICENSE`.
- [ ] Confirm whether Apache-2.0 remains the appropriate choice.
- [ ] Audit direct and transitive dependency licenses for intended distribution modes.
- [ ] Audit copied/adapted/generated code and external project references for attribution obligations.
- [ ] Add `NOTICE` or third-party attribution files if required.
- [ ] Decide DCO vs CLA vs neither.
- [ ] Document copyright ownership/contributor treatment.
- [ ] Confirm package publication does not omit required license notices.

## Brand and trademark

- [ ] Perform BrainGate name/trademark clearance in intended markets.
- [ ] Decide whether the project and commercial service will share the same mark.
- [ ] Define acceptable use of the project name/logo by forks and third-party services.
- [ ] Add a trademark policy when needed.
- [ ] Review descriptive use of provider names/logos and avoid implied endorsement.

## Community governance

- [ ] Add `CONTRIBUTING.md`.
- [ ] Add a Code of Conduct.
- [ ] Define maintainer/decision model.
- [ ] Add `CODEOWNERS`, especially for security/provider/execution boundaries.
- [ ] Document ADR expectations for architectural changes.
- [ ] Document provider-adapter acceptance and deprecation policy.
- [ ] Define issue/PR support expectations.
- [ ] Define policy for security-sensitive contributions.

## Public security program

- [ ] Add a public vulnerability-disclosure `SECURITY.md` at the conventional repository location, distinct from the internal threat-model document if appropriate.
- [ ] Publish supported release/security-update windows.
- [ ] Document how to report a provider integration that becomes unsafe after a CLI update.
- [ ] Review repository Git history for secrets, credentials, private exports, internal URLs, personal data, and test artifacts.
- [ ] Review fixtures and logs for provider/session identifiers.
- [ ] Perform an adversarial filesystem/symlink/path audit.
- [ ] Perform platform-specific review for Linux, macOS, WSL, and any claimed Windows support.
- [ ] Review subprocess environment allowlists/denylists.
- [ ] Review imported-memory attack surface and malicious-repository instruction surface.
- [ ] Confirm cloud/commercial code cannot silently weaken local safety policy when added later.

## Provider-policy readiness

For every provider claimed as supported:

- [ ] Verify authentication path against current official documentation.
- [ ] Verify the integration does not scrape credentials or rely on private endpoints.
- [ ] Verify subscription vs API billing behavior.
- [ ] Document supported CLI version range.
- [ ] Add versioned capability/safety probes where assumptions can drift.
- [ ] Document filesystem/network/tool permissions used by BrainGate.
- [ ] Document known platform limitations.
- [ ] Define fail-closed behavior when required capabilities disappear.
- [ ] Review provider terms relevant to automated orchestration and commercial usage.

## Installation and first-run experience

- [ ] Provide a clean-machine installation path.
- [ ] Decide npm/binary/package-manager distribution strategy.
- [ ] Document required Node/pnpm/runtime versions.
- [ ] Add a single quick-start path for one provider.
- [ ] Add a multi-provider setup guide.
- [ ] Add an Anthropic-only/single-provider guide.
- [ ] Document model-catalog setup without asking users to invent capability scores blindly.
- [ ] Provide `doctor` guidance for common failures.
- [ ] Test install/uninstall/update behavior.
- [ ] Document where local BrainGate state is stored and how to remove/back it up.

## Platform support

- [ ] Publish an explicit support matrix.
- [ ] Run CI/tests on each supported OS rather than only documenting expectations.
- [ ] Test path canonicalization and symlink behavior per OS.
- [ ] Test worktree lifecycle and cleanup per OS.
- [ ] Test process timeout/kill behavior per OS.
- [ ] Test provider discovery with missing/outdated/broken binaries.
- [ ] Clearly mark experimental or fail-closed provider/platform combinations.

## Reliability and recovery

- [ ] Test interrupted tasks/process crashes.
- [ ] Test stale/orphaned worktrees and recovery.
- [ ] Test SQLite crash/reopen behavior.
- [ ] Define backup/restore expectations for canonical memory and task state.
- [ ] Test quota exhaustion and unknown quota states.
- [ ] Test provider CLI upgrades that change output or flags.
- [ ] Test large repositories and large context packs.
- [ ] Test large memory imports and malformed exports.
- [ ] Test concurrent BrainGate invocations against the same project.
- [ ] Document how to safely reset local BrainGate state without touching the source repository.

## Test and quality gates

- [ ] Publish CI requirements for pull requests.
- [ ] Add release-blocking regression suites for security invariants.
- [ ] Add adversarial tests for project isolation.
- [ ] Add malicious skill/instruction tests.
- [ ] Add provider-version drift fixtures.
- [ ] Add quota/usage provenance regression tests.
- [ ] Add fuzz/property tests where they materially improve path/parser boundaries.
- [ ] Define minimum quality requirements for new provider adapters.

## Release engineering

- [ ] Choose versioning scheme (SemVer unless a stronger reason exists).
- [ ] Add changelog/release-note process.
- [ ] Decide release cadence and support window.
- [ ] Automate reproducible builds/package publishing.
- [ ] Sign releases/artifacts where practical.
- [ ] Generate SBOM/provenance if appropriate for enterprise adoption.
- [ ] Add upgrade/migration tests for persistent SQLite schemas.
- [ ] Document breaking-change policy for provider/skill SDK contracts.

## Documentation

- [ ] README suitable for a public visitor rather than private dogfood only.
- [ ] Architecture overview.
- [ ] Public threat model.
- [ ] Product/open-source/commercial boundary.
- [ ] Quick start.
- [ ] Provider setup/reference.
- [ ] Memory model and import safety.
- [ ] Routing/reviewer independence explanation.
- [ ] Worktree/write safety explanation.
- [ ] Extension/provider adapter guide.
- [ ] Skill authoring/security guide.
- [ ] Troubleshooting guide.
- [ ] FAQ covering subscription/API billing boundaries.

## Open-source/commercial architecture seam

- [ ] Open-source local operation has no required dependency on proprietary services.
- [ ] Commercial/cloud packages depend on stable OSS contracts, not the inverse.
- [ ] Remote control transport is an interface rather than a hard-coded cloud dependency.
- [ ] Sync backend is optional and explicit.
- [ ] Organization policy sources are pluggable/optional for Community mode.
- [ ] Cloud outage does not disable unrelated local workflows.
- [ ] Commercial telemetry cannot silently expand local data collection.
- [ ] Provider credentials are not required to be uploaded to BrainGate Cloud for ordinary BYO-subscription workflows.

## Commercial beta readiness

These are **not** blockers for an OSS technical preview, but are prerequisites before charging users for cloud/team features.

- [ ] Define commercial entity/billing/tax setup.
- [ ] Terms of Service.
- [ ] Privacy Policy.
- [ ] Data Processing Agreement strategy for teams/enterprise.
- [ ] Subprocessor list and data-flow inventory.
- [ ] Cloud security architecture review.
- [ ] Authentication/account recovery design.
- [ ] Encryption/key-management design and externally accurate claims.
- [ ] Subscription/billing/entitlement system.
- [ ] Abuse/rate-limit/support policies.
- [ ] Backup/disaster-recovery plan.
- [ ] Incident response plan.
- [ ] Customer deletion/export flows.
- [ ] Remote approval authorization model.
- [ ] Team RBAC model.
- [ ] Enterprise SSO/SCIM decision based on actual demand.

## Evidence before pricing

Before turning current pricing hypotheses into published plans, collect evidence for:

- [ ] active OSS usage and retention;
- [ ] percentage of users with one vs multiple providers;
- [ ] frequency/value of remote approval use cases;
- [ ] routing/quota savings users can observe;
- [ ] willingness to pay for sync/remote/team capabilities;
- [ ] support burden by provider/platform;
- [ ] cloud cost independent of model-token resale;
- [ ] enterprise demand for policy/compliance/deployment controls.

## Launch gate

BrainGate should not be declared public-production-ready merely because the repository builds.

Before a public technical preview, the maintainers should be able to answer yes to all of the following:

1. Can a new developer install and run a safe read-only task from documented instructions?
2. Is the repository's actual license unambiguous?
3. Have third-party license/attribution obligations been reviewed?
4. Can security vulnerabilities be reported privately?
5. Are supported providers/platforms stated truthfully?
6. Does Community mode remain useful without a BrainGate account/cloud service?
7. Can a provider integration fail closed when its safety assumptions drift?
8. Is private dogfood/history/credential material absent from the public Git history?
9. Are OSS vs commercial boundaries documented without misleading users?
10. Are release artifacts reproducible enough to support updates and incident response?
