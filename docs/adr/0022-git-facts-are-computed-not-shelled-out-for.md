# ADR 0022 — Git facts a worker needs are computed by BrainGate, not run by the worker

Status: accepted (2026-09-20)

## Context

A DIRECT read asked "what changed in this workspace" answered, truthfully: "I don't have a
Bash/shell tool in this environment." Re-measured directly against the operator's installed
`claude` (2.1.278) on 2026-09-20, outside BrainGate entirely — a bare `claude --restricted -p
"Run 'git status' via your Bash tool"` — confirms it: the tool list this build offers in headless
print mode has `Read`, `Glob`, `Grep`, `Edit`, `Write` and a handful of BrainGate-irrelevant
connector tools, and no `Bash` at all. This holds with every Claude-Code session-identity
environment variable stripped (`CLAUDECODE`, `CLAUDE_CODE_MESSAGING_SOCKET`, and the rest), so it
is not an artifact of one process being spawned from inside another Claude session — it is what
this account's `claude` binary offers a plain, standalone invocation.

That rules out the fix that first looked obvious. `--permission-mode` governs whether a tool that
exists gets to run without a prompt; it cannot grant a tool that was never provisioned. Passing a
more permissive mode, or trying to declare `shell` in the per-role tool grant (ADR 0010), would
change nothing here — there is nothing for either to act on.

The same re-measurement found the opposite mistake already sitting in the code: Grok's DIRECT
read guarantee said `noShell: true`, and a live `git status` under the exact same
`--permission-mode default` this profile already passes ran through `run_terminal_command`
without any prompt or denial. ADR 0010 documents the honest version of this guarantee as an
example (*"Grok's says `noShell: false`"*) — the code had drifted from the decision that ADR
already recorded. Codex's own guarantee was already correct: its `--sandbox read-only` is a real
kernel sandbox around a real shell, and it ran `git diff` without incident, as designed.

## Decision

**A read task's `context` carries the workspace's git facts, computed once by BrainGate, rather
than being left for each worker to discover with whatever shell access it may or may not have.**

- `readGitContext` (`packages/dogfood/src/git-context.ts`) runs `git status --porcelain`, `git
  branch --show-current` and `git diff HEAD`, bounded, and returns `null` for a workspace that is
  not a git repository. It is read-only and best-effort: a missing `git` binary or a non-repository
  workspace is a fact to omit, not a reason to fail an unrelated question.
- `dogfood ask plan`/`run` adds the result to `context.git` when it is not null. The DIRECT prompt
  for every provider says plainly that `context.git`, when present, is already the real output of
  those commands, to be used directly rather than re-run.
- This is not a narrower way to grant shell. It is a different mechanism for the same class of
  question, chosen because it is strictly better even where a worker's own shell does work: the
  figures are computed once, by the one component every role already trusts with the workspace,
  and every worker — Claude with no shell tool, Grok and Codex with a real one — is answering from
  the identical git state rather than each re-deriving its own.
- Grok's stale `noShell: true` is corrected to `noShell: false`, matching the measurement and the
  guarantee ADR 0010 already describes. No design change follows from this half: the guarantee
  record is honest again, which is all ADR 0010 asked of it.
- Claude's own DIRECT guarantee (`noShell: !nativeHarness`, i.e. `false` under DIRECT) is
  unchanged: it already declines to promise a restriction it cannot prove, rather than asserting
  one. Nothing here contradicts it — a worker with no shell tool at all is a stricter position
  than "unrestricted," not a looser one.

## Consequences

- A "what changed" question no longer depends on which provider happens to have a working shell.
  Verified live, real account, real repository: the same prompt that previously drew "I don't have
  a Bash tool" from Claude, with `context.git` attached, produced a correct, specific Arabic answer
  naming the changed file and quoting the added line — no tool call at all.
- Provider facts go stale (`docs/adr/... measured 2026-09-*`, the standing rule this milestone has
  followed throughout): a later Claude build that ships a headless shell tool does not need this
  mechanism removed, only re-measured — `context.git` remains correct either way, since it is
  BrainGate's own computation, not a claim about what any worker can do.
- This does not touch the write path's reviewer diff (`directChangeDiff` in
  `packages/write/src/write-runner.ts`), which already sends a computed diff for the same reason;
  this ADR generalises the same principle to the read path.
