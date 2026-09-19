# Security policy

This file is the conventional, public entry point for reporting a security issue in BrainGate. It
is deliberately short and distinct from [`docs/SECURITY.md`](docs/SECURITY.md), which is the
internal threat model: the trust boundaries BrainGate assumes, the controls it enforces, and why
they are expected to hold. Read that document to understand what a reported issue is being
measured against.

## Reporting a vulnerability

**Report privately, not through a public GitHub issue.** A public issue on a project that drives
other people's AI coding CLIs and touches their source code is itself a disclosure.

<!-- TODO(operator): replace this placeholder before the technical preview is announced publicly.
     A GitHub private security advisory ("Report a vulnerability" under the repository's Security
     tab) or a dedicated security-contact mailbox both work; pick one and remove this comment. -->
- **Contact:** *(operator to fill in — no disclosure contact is published yet)*

Please include:

- what you found and why it matters (which trust boundary in `docs/SECURITY.md` it crosses, if you
  can tell);
- the BrainGate commit or version, the provider CLI and version involved if relevant, and the
  platform;
- steps to reproduce, or a minimal example;
- whether you believe operator data (`~/.braingate`, another CLI's own settings) was reachable, and
  how.

## Scope

In scope: BrainGate's own code — routing, memory, project isolation, worktree and diff-guard
enforcement, the provider adapters in `packages/shadow`, and anything that could let a task reach
outside its project or outside the boundary its execution policy claims.

Out of scope: vulnerabilities in a provider's own CLI (`claude`, `codex`, `agy`, `grok`) that exist
independently of BrainGate — report those to the provider — and anything that requires the reporter
to already control the operator's own machine or account.

## What to expect

This is a pre-release technical preview maintained without a formal security program yet (see
[`docs/PUBLIC_RELEASE_CHECKLIST.md`](docs/PUBLIC_RELEASE_CHECKLIST.md), "Public security program").
There is no published SLA for first response or fix timelines. A report that identifies a real
boundary failure — a task reaching another project, a write escaping its worktree, operator data
(`~/.braingate`, another CLI's settings) being read or written without the operator's action — is
treated as release-blocking.

## Supported versions

BrainGate is pre-1.0 and does not yet publish a supported-version or security-update window. Report
against the `main` branch or the most recent tag; an older version is unlikely to receive a
separate fix.
