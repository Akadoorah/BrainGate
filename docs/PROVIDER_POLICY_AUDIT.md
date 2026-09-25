# Provider policy audit

Dated 2026-09-19, against the profiles in `packages/shadow/src/profiles.ts` and the CLI versions
recorded there and in ADR [0021](adr/0021-big-writes-and-default-profiles.md) (grok 1.0.30, agy
1.2.7, claude 2.1.278, codex-cli 0.153.4).

This is an audit **template with the facts BrainGate can attest to about its own code** — not a
legal reading of any provider's terms of service. It states what BrainGate does and does not do
when it drives each CLI, cites the exact flags at the time of writing, and lists what to re-measure
before treating any of it as still true. Whether a particular pattern of use is permitted under a
subscription's terms is a question for that provider's terms and the person running BrainGate, per
the [Responsible use](GUIDE.md#responsible-use) section of the guide — this document does not
answer it on their behalf.

Every section below is true of every role BrainGate can route to that provider today, staged or
DIRECT: there is exactly one code path per provider that builds its argv
(`planShadowInvocation`), and every role goes through it.

## Claude Code (`claude`)

**How BrainGate invokes it.** The official `claude` binary discovered on `PATH`, run in print mode
(`-p`) with a prompt, so the CLI does not wait for interactive input. A native session is continued
with `--resume <id>` or named with `--session-id <id>` — never both in the same invocation, because
the CLI's own help text does not document that combination (measured 2026-09-13 against claude
2.1.269). Under DIRECT (ADR [0017](adr/0017-direct-execution.md)) the run points at the workspace
the operator selected and keeps Claude's own harness — its tools, its permission prompts for an
attended run, its own subagents — exactly as a manual `claude` invocation would.

**What it does not do.** No token or session file is read from Claude Code's own storage; no flag
that bypasses Claude's permission model is ever passed; no request is made to an Anthropic API
endpoint directly — the only process that talks to the provider is the `claude` binary itself,
under the credentials it is already signed in with.

**What to re-check before release.**
- Re-run the version probe against whatever `claude` build is current; `CLAUDE_MINIMUM` in
  `profiles.ts` is a floor measured on an older build and can go stale (`memory/provider-cli-facts-go-stale`).
- Confirm `-p`, `--resume` and `--session-id` still mean what they meant on 2.1.278 — Claude Code
  ships weekly, and a flag's behavior is not guaranteed to be stable across releases.
- Re-verify that DIRECT still leaves an attended run's own approval prompts intact rather than
  silently suppressing them.
- **Re-measure the headless tool list** (2026-09-20 finding, ADR [0022](adr/0022-git-facts-are-computed-not-shelled-out-for.md)):
  the operator's installed `claude` 2.1.278 offers no `Bash` tool at all to a headless `-p` run —
  confirmed with every Claude-Code session-identity environment variable stripped, so it is not an
  artifact of one Claude process being spawned from inside another. `--permission-mode` cannot grant
  a tool the build never provisioned. BrainGate now computes git status/diff itself and hands it to
  every DIRECT read as `context.git` rather than depending on any worker's shell; re-check whether a
  future build changes this before assuming the workaround is still load-bearing.

## Codex (`codex`)

**How BrainGate invokes it.** The official `codex` binary, non-interactively via `codex exec` with
`--ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check --json
--output-schema <path>`, reading the prompt from stdin. Every staged role (planner, reviewer,
judge) runs from a clean temporary workspace that never contains the operator's project, gated by a
zero-model-call sandbox self-test (ADR [0010](adr/0010-tool-grants-are-earned-per-role.md)) that is
version-, platform- and policy-hash-bound and re-measured whenever any of those change. Only the
config keys the self-test proved this build accepts are ever sent (`codexReviewerConfigArgs`); an
unrecognized key would abort the run under `--strict-config` rather than being silently ignored.
Codex may also hold the executing role, in a task worktree under `workspace-write`, once the
operator scores a Codex model for it — never in the operator's real checkout directly. `--sandbox`,
`--dangerously-bypass-approvals-and-sandbox` and `--full-auto` are asserted absent from every argv
this code builds, not merely undocumented.

**What it does not do.** No ChatGPT session token is copied out of Codex's own credential storage;
authentication is proven by asking `codex` itself (`codex login status`), never by reading its
files. No OpenAI API endpoint is called outside the `codex` binary. No config key is sent that the
self-test has not already proven this build honours.

**What to re-check before release.**
- Re-run the sandbox self-test on whatever `codex-cli` build is current; an attestation is bound to
  version + platform + policy hash specifically so a Codex update invalidates it automatically, but
  the *policy comments* recording what was measured (accepted config keys, `exec resume`'s refusal
  of `-C`/`-s`) should be re-read against the changelog of any Codex upgrade.
- Confirm native Windows Codex review is still blocked and WSL still routes through the Linux path,
  per the README's stated platform limitation.
- Re-verify `--strict-config` still hard-fails on an unrecognized key rather than warning and
  continuing — that behavior is load-bearing for the accepted-key allowlist.

## Grok (`grok`)

**How BrainGate invokes it.** The official `grok` binary, non-interactively via `--prompt-file
<path> --cwd <path>`, with a custom kernel-enforced sandbox profile passed to `--sandbox` (Seatbelt
on macOS, Landlock on Linux) — never a built-in profile, because only a custom profile that fails
to apply aborts the run rather than warning and continuing (ADR
[0009](adr/0009-grok-sandbox-is-provable.md)). The sandbox is proven per run by a zero-model-call
self-test bound to version, platform and the profile's own hash. `GROK_HOME` is isolated for the
sandbox self-test's own posture; where it cannot be (staged roles reuse the operator's `~/.grok` to
keep authentication), that is stated in the README rather than assumed away, along with the three
named residual risks: MCP servers stop the run outright, hooks/plugins are named but not blocked,
and network blocking is Linux-only. `--always-approve`, `--dangerously-skip-permissions` and
`bypassPermissions` are asserted absent from every argv this code builds. Grok may also hold the
executing role, in a task worktree under a custom kernel profile whose deny list puts secrets out
of reach, once the operator scores it for that role.

**What it does not do.** No credential is copied out of `~/.grok`; the sandbox loads that directory
in place rather than extracting anything from it. No xAI API endpoint is called outside the `grok`
binary. Web search is disabled per invocation (`--disable-web-search`) unless the routed model's
grant includes it.

**What to re-check before release.**
- Re-run the sandbox self-test on whatever `grok` build is current; `GROK_MINIMUM` in `profiles.ts`
  is the version where an inapplicable custom profile started aborting instead of warning, and an
  older or newer build can change that behavior again.
- Re-measure which of MCP servers, hooks and plugins load from `~/.grok` inside the sandbox — this
  is named in `braingate doctor` output today (`grok-home-loads=...`) and needs to stay accurate
  as Grok's own config surface changes.
- Re-confirm `restrict_network` remains a real seccomp control on Linux and a documented no-op on
  macOS; a platform change here would need the attestation and the README both updated.
- **`noShell` was corrected 2026-09-20** (ADR [0022](adr/0022-git-facts-are-computed-not-shelled-out-for.md)):
  a DIRECT read's guarantee claimed `noShell: true`, but a live `git status` under this same
  `--permission-mode default` ran through `run_terminal_command` with no prompt and no denial —
  the claim was stale, not a live restriction. Re-verify this on any Grok upgrade that touches its
  headless permission model.

## Antigravity (`agy`)

**How BrainGate invokes it.** The official `agy` binary, non-interactively via `--output-format
stream-json` (staged roles) or `-p=<prompt>` (DIRECT reads), reading `--model` and an effort tier
that is a property of the model id itself rather than a per-task knob (measured 2026-09-19 on agy
1.2.7). Antigravity is the one provider that is **accepted by the operator rather than proven per
run** (ADR [0008](adr/0008-operator-accepted-providers.md)): it keeps its settings and its
credentials under the same `HOME` with no second variable to separate them, so BrainGate cannot
hand it a scoped configuration the way it does for Codex and Grok. Nothing here can prove what an
Antigravity run may reach outside the project, so nothing tries — access stays closed until the
operator runs `braingate providers accept google`, which expires after 30 days and is never
inferred from Antigravity being installed or signed in. A DIRECT run is possible only when the
operator's own settings file already allows headless reads and shell commands
(`~/.gemini/antigravity-cli/settings.json`, ADR
[0020](adr/0020-antigravity-direct-is-read-from-its-own-settings.md)) — BrainGate reads that file to
decide whether the gate is open and **never writes to it**. `--dangerously-skip-permissions` is
asserted absent from every argv this code builds; headless auto-denial (Antigravity's own behavior
when a tool would need a prompt it cannot show) is the only tool policy BrainGate relies on for this
provider.

**What it does not do.** BrainGate does not edit, create or migrate
`~/.gemini/antigravity-cli/settings.json` under any code path — the smoke and integration tests for
this provider assert the file's mtime is unchanged. No credential is copied out of Antigravity's
home. No Google API endpoint is called outside the `agy` binary. Acceptance widens *which provider
may be asked*; it does not widen what a task worktree, diff guard or checkout fingerprint verifies
afterward.

**What to re-check before release.**
- Re-measure headless tool denial on whatever `agy` build is current — the exact rules needed
  (`read_file(*)` and `command(*)`) were found empirically on 1.2.2 and reconfirmed on 1.2.7, and an
  Antigravity update could change what its own settings format accepts or what it auto-denies.
- Re-confirm the `-p=` route (DIRECT) and the `--input-format stream-json` route (staged) still
  produce the envelope shapes `streaming.ts` parses; a provider update that changes either is a
  silent parse failure, not a loud one, until someone watches a real run.
- Re-verify that acceptance's 30-day expiry and the isolated-attestation cache are still being
  read from the operator's own home rather than a location a test could accidentally point
  elsewhere.

## What is common to all four

- **Backoff, never circumvention.** A refusal, a rate limit or a reported quota exhaustion is
  recorded as BrainGate's own operational backoff (ADR
  [0012](adr/0012-quota-state-is-native-only.md)) and surfaced as such
  (`describeRefusalBackoff`: "BrainGate is resting `<pool>` until `<time>` after a refusal; it was
  not counted as a limit."). Nothing retries past a refusal, rotates a credential to route around
  one, or represents one subscription as more than one independent quota authority.
- **No account sharing.** Every invocation runs under the operator's own signed-in CLI session, on
  the machine BrainGate is running on. There is no code path that accepts another person's
  credentials, proxies a request on their behalf, or pools quota across accounts.
- **No direct API calls with subscription credentials.** BrainGate never constructs an HTTP request
  to Anthropic, OpenAI, xAI or Google's model APIs itself; every model call happens by shelling out
  to the official CLI, which decides for itself how to reach the provider.
- **Known API-key and base-URL environment variables are stripped** from every subprocess BrainGate
  starts, so a stray `ANTHROPIC_API_KEY` or similar cannot silently move a subscription-backed run
  onto per-token billing without anyone asking for that.

## Standing limitation

This document is accurate as of the CLI versions named above and no later. Per
`AGENTS.md` ("Working with provider CLIs"), a recorded provider limitation is a measurement with a
date, not a standing fact — these CLIs ship weekly, and this audit should be re-run, not assumed,
before any public release announcement.
