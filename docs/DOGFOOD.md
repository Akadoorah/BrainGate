# Shadow dogfooding

Milestone 8 connects BrainGate to subscription CLIs only through **read-only shadow profiles**. No provider process receives project write capability.

## Rollout gates

1. `dryRun`: route, auth/version/path checks and Task Brief only. Zero model calls.
2. T0/T1 shadow: read-only questions/explanations against one registered repository.
3. T2 shadow: debugging/planning with the same no-write boundary.
4. Independent shadow review where Budget Governor requires it.
5. Future worktree writes only after a separate isolation milestone and explicit approval.

## Enabled profiles

### Claude Code

BrainGate requires Claude Code 2.1.248+ and uses restricted print mode. The profile restricts built-in tools to `Read,Glob,Grep`, removes MCP tools, disables slash commands/Chrome/session persistence, pins the routed model and sends the task/context over stdin instead of the process command line.

BrainGate never uses `--bare` for subscription shadow runs. Bare mode changes authentication behavior and still exposes Bash/edit tools; restricted mode is the evaluation-harness boundary designed for this use case.

`claude auth status` is a zero-model-call metadata probe. When it proves a logged-in Claude subscription, BrainGate can use that native auth evidence. Direct billing environment overrides are removed before every child process.

### GitHub Copilot CLI

BrainGate uses prompt mode with only `view,grep,glob` available. Write, shell, URL and memory permissions are explicitly denied, built-in MCP is disabled, custom instructions/remote/export/experimental behavior are disabled, and the routed model is pinned.

The task/context is placed in a private temporary attachment (mode 0600) and deleted after the process. `COPILOT_HOME` points at an empty per-run temporary configuration directory so persisted local permissions/config do not broaden the session.

Because BrainGate currently has no verified zero-model-call Copilot auth probe, automated Copilot shadow use requires a short-lived local `user-confirmed-oauth` subscription attestation. An explicit API auth observation always overrides and rejects such an attestation.

## Blocked profiles

- **Codex CLI:** direct `exec --sandbox read-only` is not yet used because BrainGate has not attached the restricted-readable-roots app-server policy.
- **Grok Build:** current sandbox trade-offs do not simultaneously prove project-only reads and zero project writes under BrainGate's clean-config requirements.
- **Antigravity:** strict mode has not yet been proven as a stable per-invocation headless enforcement flag.

Blocked does not mean unsupported forever. Provider discovery and routing remain vendor-neutral; invocation is enabled only when the isolation contract is proven.

## Privacy and audit

- Shadow input is never persisted by BrainGate as a task event.
- Claude input uses stdin; Copilot uses an ephemeral attachment.
- Task Ledger stores provider/model/role, duration and call count, not model output.
- Token usage remains `unknown` unless a provider reports a trustworthy figure.
- `.braingate/dogfood/` is ignored by Git so local regression captures never enter a project repository accidentally.
