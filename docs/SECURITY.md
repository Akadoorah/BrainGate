# Security model

BrainGate operates near valuable source code and authenticated developer tooling. Prompt instructions are not considered security controls.

## Trust boundaries

- BrainGate core: trusted local orchestrator.
- Provider CLI processes: untrusted workers with bounded capabilities.
- Project repositories: isolated security domains.
- Skills: executable/instruction-bearing capabilities requiring explicit authorization.
- Memory: untrusted input until validated; canonical memory has a single writer.

## Required controls

### Project isolation

Every project has an immutable explicit `project_id`. Project-scoped memory is stored separately and retrieval APIs require the project identity. Cross-project retrieval is denied by default.

### Filesystem isolation

Write agents operate in task-specific Git worktrees. Review-only agents receive read-only or separately materialized views where feasible. Provider prompts are never the sole enforcement mechanism.

For the Codex reviewer path, BrainGate validates that the source CWD belongs to the registered project, but Codex itself is **not** started from that repository. BrainGate creates a fresh private staged workspace, substitutes that path into the verified permission profile, runs Codex there, and deletes the stage after the call. The real project repository is never granted as a Codex workspace root in this path.

### Codex reviewer self-test

Codex is reviewer-only in the hardened shadow path. Before it becomes eligible, a zero-model-call local self-test must prove the filesystem contract for the installed Codex version and platform:

1. a canary inside the staged workspace is readable;
2. a canary outside that workspace is not readable;
3. a write inside the staged workspace is denied.

The resulting isolation attestation is bound to the Codex version, platform, and BrainGate permission-profile hash and expires after a short period. A version/profile/platform change requires a new self-test. Native Windows remains fail-closed in this milestone; WSL follows the Linux sandbox path and must pass the same test.

Codex execution additionally uses ephemeral mode, ignores user exec-policy rules and user config, uses a clean non-repository CWD, pins the routed model, and explicitly disables unnecessary model-visible surfaces such as shell/code execution, web search, apps/plugins, browser/computer use, memory, worktrees, and multi-agent/collaboration features. If required configuration is rejected by the installed CLI, strict configuration causes the run to fail rather than silently broaden permissions.

### Skill isolation

Skills have explicit scope and allowlists. A worker cannot load a skill outside the active project's authorization even if it knows the skill's name.

### Secret handling

Default deny patterns include `.env`, `.env.*`, `credentials.*`, private keys, certificates, and configured secret paths. Secrets must never be persisted to task transcripts, canonical memory, logs, or generated fixtures. Test/dummy credentials should be used where possible.

### Subscription authentication

BrainGate invokes official provider CLIs using the user's existing supported login session. It must not scrape OAuth tokens, call private endpoints, pool accounts, share credentials, bypass usage limits, or silently fall back to billable API credentials.

In subscription mode, child environments remove known provider API-key/direct-billing environment variables. For Codex, `codex login status` is used as a zero-model-call native signal: ChatGPT authentication is accepted for the subscription path, while API-key/access-token modes are not.

BrainGate does not inspect, copy, parse, or persist provider auth-token files such as Codex `auth.json`.

### Process/network permissions

Execution profiles declare read/write/shell/network permissions. High-risk permissions require policy approval. Where a provider cannot hard-enforce a restriction, BrainGate compensates with OS/filesystem/process boundaries or refuses the unsafe mode.

### Memory integrity

Workers propose memory updates. A validation layer checks project scope, source evidence, sensitivity, and conflicts before canonical storage. Canonical architectural/business facts do not expire automatically; temporary observations do.

### Auditability

Task ledgers record classification, routing, provider/model role, permission grants, file activity metadata, verification, retries, usage source quality, and memory changes. Raw provider reasoning/event streams are not canonical task output.

## Threats explicitly in scope

- Cross-project context leakage.
- Secret exfiltration or accidental logging.
- Prompt injection through repository content or skills.
- Agent modifying the wrong checkout.
- Provider reading outside an authorized staged/project root.
- Infinite repair/review loops.
- Misreported quota/token usage.
- Provider CLI behavior changing unexpectedly.
- Compromised or malicious third-party skills.
