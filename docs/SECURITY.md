# Security model

BrainGate will eventually operate near valuable source code and authenticated developer tooling. Prompt instructions are not considered security controls.

## Trust boundaries

- BrainGate core: trusted local orchestrator.
- Provider CLI processes: untrusted workers with bounded capabilities.
- Project repositories: isolated security domains.
- Skills: executable/instruction-bearing capabilities requiring explicit authorization.
- Memory: untrusted input until validated; canonical memory has a single writer.

## Required controls

### Project isolation

Every project has an immutable explicit `project_id`. Project-scoped memory must be stored separately and retrieval APIs require the project identity. Cross-project retrieval is denied by default.

### Filesystem isolation

Write agents operate in task-specific Git worktrees. Review-only agents receive read-only or separately materialized views where feasible. Provider prompts are never the sole enforcement mechanism.

### Skill isolation

Skills have explicit scope and allowlists. A worker cannot load a skill outside the active project's authorization even if it knows the skill's name.

### Secret handling

Default deny patterns include `.env`, `.env.*`, `credentials.*`, private keys, certificates, and configured secret paths. Secrets must never be persisted to task transcripts, canonical memory, logs, or generated fixtures. Test/dummy credentials should be used where possible.

### Subscription authentication

BrainGate invokes official provider CLIs using the user's existing supported login session. It must not scrape OAuth tokens, call private endpoints, pool accounts, share credentials, bypass usage limits, or silently fall back to billable API credentials.

In subscription mode, child environments should remove known provider API-key environment variables unless an adapter explicitly requires a user-approved API mode.

### Process/network permissions

Execution profiles declare read/write/shell/network permissions. High-risk permissions require policy approval. Where a provider cannot hard-enforce a restriction, BrainGate must compensate with OS/filesystem/process boundaries or refuse the unsafe mode.

### Memory integrity

Workers propose memory updates. A validation layer checks project scope, source evidence, sensitivity, and conflicts before canonical storage. Canonical architectural/business facts do not expire automatically; temporary observations do.

### Auditability

Task ledgers record classification, routing, provider/model role, permission grants, file activity metadata, verification, retries, usage source quality, and memory changes.

## Threats explicitly in scope

- Cross-project context leakage.
- Secret exfiltration or accidental logging.
- Prompt injection through repository content or skills.
- Agent modifying the wrong checkout.
- Infinite repair/review loops.
- Misreported quota/token usage.
- Provider CLI behavior changing unexpectedly.
- Compromised or malicious third-party skills.
