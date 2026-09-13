# Security model

BrainGate operates near valuable source code and authenticated developer tooling. Prompt instructions are not considered security controls.

## Trust boundaries

- BrainGate core: trusted local orchestrator.
- Provider CLI processes: untrusted workers with bounded capabilities.
- Project repositories: isolated security domains.
- Skills: executable/instruction-bearing capabilities requiring explicit authorization.
- Memory: untrusted input until validated; canonical memory has a single writer.
- Imported history: untrusted project-scoped evidence until an explicit supervisor promotion.
- Dogfood telemetry: sanitized project-local experiment metadata, not a transcript or memory source.

## Required controls

### Project isolation

Every project has an immutable explicit `project_id`. Project-scoped memory and dogfood telemetry are stored separately and APIs require the project identity. Cross-project retrieval is denied by default.

M12 `braingate init` writes `.brain/project.json` only after resolving the Git top-level repository. `.brain/` is added to the repository's local Git exclude file rather than tracked `.gitignore`; conflicting existing project identity is refused rather than overwritten.

Memory-import previews are bound to the active project identity. A preview created for one project cannot be submitted to another project's memory store.

### Filesystem isolation

Write agents operate in task-specific Git worktrees. Review-only agents receive read-only or separately materialized views where feasible. Provider prompts are never the sole enforcement mechanism.

For the Codex reviewer path, BrainGate validates that the source CWD belongs to the registered project, but Codex itself is **not** started from that repository. BrainGate creates a fresh private staged workspace, substitutes that path into the verified permission profile, runs Codex there, and deletes the stage after the call. The real project repository is never granted as a Codex workspace root in this path.

Writes use a restricted provider profile inside a task worktree. The source checkout is fingerprinted before anything runs and compared after the provider call and again after review. The fingerprint covers `HEAD`, the index, tracked changes, and the *content* of untracked and ignored files — so a rewritten `.env`, which leaves `git status` empty, is caught. Claude, Grok and Codex may each hold the executing role; each has its own bounded workspace and its own proof, and all three pass through the same worktree, fingerprint, diff-guard and human-merge checks. Sensitive files, Git/control-plane configuration, and agent instruction files are rejected by the guarded diff boundary. Current write scope is limited to T0-T2 low/medium-risk changes; high/critical-risk or T3/T4 writes fail closed before worktree/provider execution.

### Codex isolation self-test

Codex fills planning, review and judging from a staged workspace, and may hold the executing role in a task worktree once a Codex model is scored for it. Before any of those becomes eligible, a zero-model-call local self-test must prove the filesystem contract for the installed Codex version and platform:

1. a canary inside the staged workspace is readable;
2. a canary outside that workspace is not readable;
3. a write inside the staged workspace is denied.

The resulting isolation attestation is bound to the Codex version, platform, and BrainGate permission-profile hash and expires after a short period. A version/profile/platform change requires a new self-test. Native Windows remains fail-closed in this milestone; WSL follows the Linux sandbox path and must pass the same test.

Codex execution additionally uses ephemeral mode, ignores user exec-policy rules and user config, uses a clean non-repository CWD, pins the routed model, and disables a declared set of model-visible surfaces — shell and code execution, web search, apps and plugins, browser and computer use, memory, worktrees, and multi-agent collaboration. If required configuration is rejected by the installed CLI, strict configuration causes the run to fail rather than silently broaden permissions.

Read that list for what it is. It describes the Codex **isolation contract** this proof was earned
under: the denied writes are the evidence, so the denials are part of the proof (class A in ADR
[0014](adr/0014-native-runtime-preservation.md)). It is not a claim that a Codex worker is inherently
a text-only reader, and it is not the default posture BrainGate intends for interactive work. Codex
runs this way because this is the boundary BrainGate can prove for it today; a Codex run in a mode
whose boundary is proven some other way would carry whatever that proof supports.

### What a role is allowed to do

Capabilities are granted per role rather than per provider, and each kind above `read` is earned
by proof of a different kind (ADR 0010):

- **Structural** — `edit` is bounded by a task worktree BrainGate created and by the source
  fingerprint. It does not expire and does not depend on the provider behaving.
- **Attested** — `shell` needs a current sandbox self-test bound to the CLI version, the
  platform, and a hash of the policy it was earned under.
- **Accepted** — `web` needs your explicit, separate decision (`braingate providers allow-web`),
  because what leaves this machine is the one thing no local check can see. Accepting an
  unscoped provider does **not** grant it.

MCP is refused for every role today: BrainGate has no per-invocation way to prove what an MCP
server reaches. Read profiles pass an empty MCP configuration under strict mode, so the servers are
not loaded rather than merely denied.

That refusal is classified as a **legacy** restriction in ADR
[0014](adr/0014-native-runtime-preservation.md), not as a permanent property of the product. It
contradicts the principle that a runtime keeps its own harness, and replacing it needs a per-server
policy — which servers, reaching what — rather than a switch from none to all. Until that policy
exists the refusal stands, and the plan says so before anything is spent.

A capability probe reads each installed CLI's own help text — no prompt, no model, no cost — and
can only narrow what a profile declares. A flag this build has dropped is refused with a reason
instead of failing at the provider.

### Helpers a provider runs on its own

Where a provider accepts subagent definitions BrainGate wrote, a run may fan out to read-only
helpers whose tools are a subset of the lead's. That is bounded twice: the budget must already
allow more than one agent at once (T3 and T4 only), and the task carries a cumulative ceiling on
agent executions inside providers. Where a provider reports its own count — Claude does — it is
recorded as `native`; where it reports nothing, the run is charged the ceiling rather than
credited with zero, because an uncounted helper must not be a free one.

### The interactive session thread

An interactive session keeps the last six exchanges so a follow-up resolves. It is written to
disk, and treated as such: kept under the project's own storage directory, redacted through the
secret guard before writing, each answer truncated to 1,200 characters, expiring eight hours
after the last turn, and deleted by `/forget`. It is never memory and cannot become memory except
by the operator writing something down through the ordinary proposal gate.

### Reviewer independence

Reviewer independence is graded rather than overstated:

1. `cross-provider` — strongest current automated independence;
2. `same-provider-different-model` — a separate fresh invocation from another model under the same provider authority;
3. `same-model-fresh-session` — weakest automated fallback, using the same model identity in a new invocation;
4. `none` — no automated review occurred.

Same-provider models may share the same subscription quota pool and are never presented as separate provider authorities merely because model IDs differ. BrainGate records the independence level and whether the quota pool is shared.

Critical tasks still require cross-provider/separate-authority review and fail closed when it is unavailable. Noncritical T4 work may receive same-provider review, but the receipt marks human approval as required before acceptance.

### Skill isolation

Skills have explicit scope and allowlists. A worker cannot load a skill outside the active project's authorization even if it knows the skill's name.

### Secret handling

Default deny patterns include `.env`, `.env.*`, `credentials.*`, private keys, certificates, and configured secret paths. Secrets must never be persisted to task transcripts, canonical memory, logs, dogfood telemetry, or generated fixtures. Test/dummy credentials should be used where possible.

Imported history passes through the same memory secret checks as ordinary proposals. The importer does not bypass canonical-memory sensitivity validation.

### Subscription authentication

BrainGate invokes official provider CLIs using the user's existing supported login session. It must not scrape OAuth tokens, call private endpoints, pool accounts, share credentials, bypass usage limits, or silently fall back to billable API credentials.

In subscription mode, child environments remove known provider API-key/direct-billing environment variables. For Codex, `codex login status` is used as a zero-model-call native signal: ChatGPT authentication is accepted for the subscription path, while API-key/access-token modes are not.

BrainGate does not inspect, copy, parse, or persist provider auth-token files such as Codex `auth.json`.

Conversation-history bootstrap is local-file based. BrainGate does not scrape ChatGPT, Claude, or other provider web sessions to obtain historical conversations.

### Process/network permissions

Execution profiles declare read/write/shell/network permissions. High-risk permissions require policy approval. Where a provider cannot hard-enforce a restriction, BrainGate compensates with OS/filesystem/process boundaries or refuses the unsafe mode.

### Memory integrity

Workers propose memory updates. A validation layer checks project scope, source evidence, sensitivity, and conflicts before canonical storage. Canonical architectural/business facts do not expire automatically; temporary observations do.

Historical imports use the same proposal/supervisor boundary. `memory preview` persists nothing. `memory import` creates proposals only. `memory promote` requires explicit evidence references and a confidence value before the existing supervisor creates a canonical record. ChatGPT-style imports are bounded historical extracts rather than full transcript persistence or wholesale context injection.

### Dogfood telemetry and adaptation

Each project's M12 experiment data is stored in its own `dogfood.sqlite` under that project's BrainGate storage directory. Database metadata is bound to the explicit `project_id`; run and feedback tables are append-only at the SQLite layer.

Dogfood telemetry may contain task UUIDs, predicted/effective complexity and risk, classifier rule version, provider/model roles, reviewer verdict, outcome, usage evidence, applied prior metadata, and user-supplied outcome labels. It must not persist raw task text, model answers, candidate diffs, review findings, provider reasoning, provider auth material, or secrets.

Regression JSONL exports contain the same sanitized metadata subset and are deterministic. The default export path is under the project's locally ignored `.brain/` directory.

Adaptive priors are project-local and mode-local (`ask` vs `write`). They require a minimum labeled sample count and sustained underprediction before activation. M12 priors may only raise complexity/risk floors; they cannot lower a classifier result or mutate model-catalog scores automatically.

### Auditability

Task ledgers record classification, routing, provider/model role, permission grants, file activity metadata, verification, retries, usage source quality, and memory changes. Raw provider reasoning/event streams are not canonical task output. Dogfood reports summarize sanitized experiment metadata separately from canonical task/memory state. Workflow receipts distinguish cross-provider review from weaker same-provider/fresh-session review.

## Threats explicitly in scope

- Cross-project context, imported history, or telemetry leakage.
- Secret exfiltration or accidental logging.
- Stale or incorrect historical conversation claims becoming canonical facts.
- Prompt injection through repository content, imported history, or skills.
- Agent modifying the wrong checkout.
- Provider reading outside an authorized staged/project root.
- Infinite repair/review loops.
- Misreported quota/token usage.
- Overstating reviewer independence when multiple models share one provider/account.
- Provider CLI behavior changing unexpectedly.
- Compromised or malicious third-party skills.
- Unsafe adaptation caused by a small or noisy dogfood sample.

## DIRECT execution and the security model

The default interactive policy runs the native CLI in the workspace the operator selected (ADR
[0017](adr/0017-direct-execution.md)). That is a deliberate change to where the boundary sits, and it
is worth stating exactly what it does and does not claim.

- **It is the operator's own runtime, in the operator's own directory, on purpose.** The runtime's
  permission model is the one they accepted when they installed and signed into it, and under DIRECT
  BrainGate stops substituting its own tool allowlist, MCP refusal and declared subagents for it.
- **Nothing is granted that the runtime would have asked about.** In a headless run there is nobody to
  answer a prompt, so a tool the CLI would prompt for is refused by the CLI. BrainGate reports that as
  the runtime's decision rather than presenting it as a BrainGate guarantee.
- **What is still enforced by BrainGate**: the secret and version-control deny list in the Claude
  settings file (`.env`, credentials, keys, `.git` internals, agent/control-plane configuration); no
  commit, no merge, no branch switch, no reset, no clean; and the read-only intent check, which
  fingerprints the workspace before and after and refuses a read that changed it.
- **The strict modes still exist and still mean what they meant.** A worktree write never touches the
  workspace; a snapshot read cannot. Both are selected explicitly, and an unattended workflow uses
  them or the `unattended` policy rather than inheriting the interactive default.
- **A DIRECT write leaves uncommitted changes in the workspace.** That is the point of the policy, and
  it is reported: which files changed, by which worker, under which policy, and that nothing was
  committed.
