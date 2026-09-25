# Public release readiness checklist

This checklist tracks work required before BrainGate changes from a private pre-alpha repository to a public open-source project.

A checked item should mean the artifact or control actually exists and has been reviewed. This document intentionally distinguishes product intent from release readiness.

**M23 Phase F (2026-09-19)** closed the code/docs items that were safe to do without a legal or
business decision: `LICENSE` (Apache-2.0), a dependency license scan, `SECURITY.md`,
`CONTRIBUTING.md`, `docs/PROVIDER_POLICY_AUDIT.md`, a `pnpm pack`/`npm install -g` smoke test, and a
Git-history scan for secrets and personal data. Each is marked below with what it found. What
remains — trademark clearance, the final licensing decision, DCO/CLA, Code of Conduct, a public
threat model, a support/versioning policy, and the platform-support and reliability testing
sections — needs either an operator decision this milestone did not make on their behalf, or
infrastructure (CI matrices, a package registry) this milestone did not stand up. See
`docs/ROADMAP.md` for how M23 as a whole fits the rest of the open-source release track.

## Legal and licensing

- [x] Select and add the final repository `LICENSE`. — 2026-09-19 (M23-F): Apache-2.0 added at the
      repository root, copyright "BrainGate contributors". This is the operator's own choice to add
      the license text now, made in this milestone; it is not a substitute for the next item, which
      is a broader business/legal decision and remains open.
- [ ] Confirm whether Apache-2.0 remains the appropriate choice.
- [x] Audit direct and transitive dependency licenses for intended distribution modes. — 2026-09-19
      (M23-F): `pnpm licenses list` across the whole workspace reports every dependency as MIT or
      Apache-2.0, production and dev alike:

      ```
      typescript (dev)             Apache-2.0
      @esbuild/darwin-arm64 (dev)  MIT
      @types/better-sqlite3 (dev)  MIT
      @types/node (dev)            MIT
      better-sqlite3                MIT
      esbuild (dev)                 MIT
      fsevents (dev)                MIT
      node-addon-api                MIT
      tsx (dev)                     MIT
      undici-types (dev)            MIT
      ```

      Only `better-sqlite3` and `node-addon-api` are non-dev (production) dependencies; both MIT.
      No copyleft or unlicensed third-party package was found. `npx license-checker --summary` was
      also tried and could not traverse pnpm's symlinked `node_modules` layout (it reported a
      single `UNLICENSED` entry for the workspace root itself, which is not a real finding) —
      `pnpm licenses list` is the tool that actually works for this monorepo and should be the one
      re-run before release, not `license-checker`.
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

- [x] Add `CONTRIBUTING.md`. — 2026-09-19 (M23-F): how to run the project, the real-run rule for
      provider-facing changes, and when a change needs an ADR.
- [x] Add a Code of Conduct. — 2026-09-25: `CODE_OF_CONDUCT.md` adopts the Contributor Covenant 2.1,
      with reports going to the contact in `SECURITY.md`.
- [ ] Define maintainer/decision model.
- [ ] Add `CODEOWNERS`, especially for security/provider/execution boundaries.
- [ ] Document ADR expectations for architectural changes.
- [ ] Document provider-adapter acceptance and deprecation policy.
- [ ] Define issue/PR support expectations.
- [ ] Define policy for security-sensitive contributions.

## Public security program

- [x] Add a public vulnerability-disclosure `SECURITY.md` at the conventional repository location, distinct from the internal threat-model document if appropriate. — 2026-09-19 (M23-F): root
      `SECURITY.md` added, pointing to `docs/SECURITY.md` for the threat model. **The disclosure
      contact is a placeholder** (`SECURITY.md` has a `TODO(operator)` marker) — the operator needs
      to pick a real channel (a GitHub private security advisory or a contact mailbox) before this
      is actually usable by an outside reporter. — Resolved: `a4b4e1a` replaced the placeholder with
      a real contact address.
- [ ] Publish supported release/security-update windows.
- [ ] Document how to report a provider integration that becomes unsafe after a CLI update.
- [x] Review repository Git history for secrets, credentials, private exports, internal URLs, personal data, and test artifacts. — 2026-09-19 (M23-F): ran
      `git log -p --all | grep -iE "api[_-]?key|token|password|sk-|Bearer"` and a search for the
      operator's home paths/email across tracked files and pushed history. Findings (reported to
      the operator, history not rewritten):
      - No real credentials or API keys found. Every `sk-...`/`Bearer ...`-shaped string in history
        is a synthetic Secret Guard test fixture (e.g. `sk-abcdefghijklmnopqrstuvwxyz012345`,
        `ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456`), and the redaction tests assert those strings are
        stripped before anything is persisted.
      - No operator home path or personal email appears in any file tracked at `HEAD`, and none
        appears in the history reachable from `origin/main` or the pushed `feat/m23-*` branches
        (checked with paths like `/Users/someone`, `/Users/you` only — both synthetic).
      - **The operator's real email address is the Git commit-author email on ~78 commits already
        pushed to `origin/main`/pushed feature branches** (alongside the GitHub no-reply address
        used on the rest, one `braingate@example.invalid` placeholder, and one stray `v@v`). This
        is real personal/business data in already-public commit metadata and needs the operator's
        decision: leave it, switch future commits to the no-reply address, or have GitHub's
        email-privacy settings/a history rewrite considered — the last of which is a decision this
        milestone deliberately did not make (`AGENTS.md`: no history rewrite without being asked).
      - A **local-only, unpushed** branch (`experiment/routing-benchmark-v2`, not on `origin`)
        contains the operator's real absolute paths (`/Users/akadoorah/...`, `/Volumes/MacVault/...`)
        in a benchmark fixture. It is not part of the public history today; flagging it so it is not
        pushed as-is if it is ever revived.
- [ ] Review fixtures and logs for provider/session identifiers.
- [ ] Perform an adversarial filesystem/symlink/path audit.
- [ ] Perform platform-specific review for Linux, macOS, WSL, and any claimed Windows support.
- [ ] Review subprocess environment allowlists/denylists.
- [ ] Review imported-memory attack surface and malicious-repository instruction surface.
- [ ] Confirm cloud/commercial code cannot silently weaken local safety policy when added later.

## Provider-policy readiness

For every provider claimed as supported:

- [x] Verify the integration does not scrape credentials or rely on private endpoints; document
      exactly how BrainGate invokes each CLI and what it does not do. — 2026-09-19 (M23-F):
      [`docs/PROVIDER_POLICY_AUDIT.md`](PROVIDER_POLICY_AUDIT.md), one section per CLI (Claude
      Code, Codex, Grok, Antigravity), with the exact non-interactive flags used, what BrainGate
      attests it does not do, and a re-check list per provider. It is a self-audit of BrainGate's
      own code against the versions named there, not a legal reading of any provider's terms —
      the next item is still open.
- [ ] Verify authentication path against current official documentation.
- [ ] Verify subscription vs API billing behavior.
- [ ] Document supported CLI version range.
- [ ] Add versioned capability/safety probes where assumptions can drift.
- [ ] Document filesystem/network/tool permissions used by BrainGate.
- [ ] Document known platform limitations.
- [ ] Define fail-closed behavior when required capabilities disappear.
- [ ] Review provider terms relevant to automated orchestration and commercial usage.

## Installation and first-run experience

- [x] Provide a clean-machine installation path. — 2026-09-19 (M23-F), partial: `apps/cli` now has
      a `build` script (esbuild, bundling every `@braingate/*` workspace package into
      `dist/main.js`, keeping `better-sqlite3` external for its native addon) and `pnpm pack`
      produces a tarball whose `package.json` depends only on `better-sqlite3` — no unpublishable
      `@braingate/*` workspace references. Smoke-tested: `pnpm --filter braingate build`, then
      `pnpm pack`, then `npm install -g <tarball> --prefix <tmp>` under a throwaway `HOME`, then
      `<tmp>/bin/braingate --help` and `braingate discover` and `braingate models list` (the last to
      exercise the native `better-sqlite3` path) all ran correctly with no monorepo checkout, no
      `tsx`, and no TypeScript toolchain on the "installing machine". This is not yet a *published*
      npm package — nothing has been pushed to any registry, and the git-clone path in the README
      remains the primary documented install — but the packaging mechanics are proven end to end.
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

- [x] Choose versioning scheme (SemVer unless a stronger reason exists). — 2026-09-25: SemVer,
      stated in `CHANGELOG.md`; before 1.0 a minor version may break, and its entry says so.
- [x] Add changelog/release-note process. — 2026-09-25: `CHANGELOG.md` (Keep a Changelog) and
      `docs/RELEASING.md`, whose checklist moves the entry to the release date and makes it the
      GitHub release notes.
- [ ] Decide release cadence and support window.
- [ ] Automate reproducible builds/package publishing.
- [ ] Sign releases/artifacts where practical.
- [ ] Generate SBOM/provenance if appropriate for enterprise adoption.
- [ ] Add upgrade/migration tests for persistent SQLite schemas.
- [ ] Document breaking-change policy for provider/skill SDK contracts.

## Documentation

- [x] README suitable for a public visitor rather than private dogfood only. — 2026-09-19 (M23-F):
      rewritten around a ten-minute path (wizard → first read → first write → `/why` → `/promote`),
      with a new "Responsible use" section and an Arabic translation
      (`docs/i18n/README.ar.md`) brought current with it. This is the README content itself; it does
      not by itself satisfy the trademark, licensing-finalization or third-party-attribution items
      elsewhere in this checklist, which remain open.
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
