# BrainGate real-project dogfood

This guide is for trying BrainGate locally against one real Git repository before enabling broader automation.

## Safety model for M12

- Provider authentication comes from each provider's official local CLI/session. Do not add API keys to BrainGate for subscription mode.
- `dogfood preflight`, `dogfood ask plan`, and `dogfood write plan` make **zero provider model calls**.
- Read-only execution requires an explicit `--execute` on `dogfood ask run`.
- Write execution requires an explicit `--execute` on `dogfood write run` and writes only to a BrainGate task worktree.
- M12 has no automatic merge, push, deploy, or production-secret access.
- High/critical-risk and T3/T4 write tasks remain blocked by the M11 write boundary.
- Dogfood telemetry is project-local and does not persist raw task text, model answers, candidate diffs, provider reasoning, or secrets.
- Adaptive routing in M12 can only raise project-local complexity/risk floors. It never silently lowers them or changes model scores.

## Where a trial or benchmark repository may live

Register the repository at a real path, not under `/tmp`. Grok's sandbox is allowed to read the
system temporary trees (`/tmp`, `/var`, `/private`), so a project whose checkout is inside one of them
fails Grok's isolation self-test with
`GROK_ISOLATION_SELF_TEST_FAILED: The applied Grok sandbox would still reach the registered project
checkout` — measured 2026-09-12 against `grok 1.0.24`. The refusal is correct, but it silently removes
Grok from the candidate set, so a measurement taken there is biased about which providers were
eligible rather than about how they performed. A project under `$HOME` (or any path outside the
sandbox's readable roots) attests normally.

## 0. Proving the real path works

`pnpm test` never lets a provider answer: every suite drives a fake executor that returns a
perfectly shaped response. That proves BrainGate's own plumbing and nothing about whether an
installed CLI actually produced a result — a gap that hid a stripped environment variable, a
role contract no model had satisfied, turn and wall-clock ceilings no real repository fit
inside, and a write path disabled by its own hardening. All four shipped green.

Two integration tests close it. They build a throwaway Git repository, register it under an
isolated `BRAINGATE_HOME`, and assert outcomes rather than arguments: an answer that could only
come from reading the working tree, and a file whose bytes actually changed in the task
worktree while the source checkout stays byte-identical.

They spend real subscription quota, so they are opt-in and are not part of `pnpm test` or CI:

```bash
pnpm test:integration
```

Run them after upgrading a provider CLI, after touching a provider profile or the role
contract, and before trusting a release. They need the provider CLIs signed in and a model
catalog already configured; the catalog is copied from your real one so the test never invents
model ids.

## 1. Prepare BrainGate

Requirements:

- Node.js 22 or later
- Git
- pnpm through Corepack
- the official provider CLIs you intend to use, already signed in to the subscription/account you control

From the BrainGate repository:

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

For the examples below, set a shell variable pointing at BrainGate's launcher. Use an absolute path.

macOS/Linux/WSL:

```bash
BRAINGATE="/absolute/path/to/BrainGate/apps/cli/bin/braingate.mjs"
```

PowerShell:

```powershell
$BRAINGATE = "C:\absolute\path\to\BrainGate\apps\cli\bin\braingate.mjs"
```

Run commands as `node "$BRAINGATE" ...` on macOS/Linux/WSL or `node $BRAINGATE ...` in PowerShell.

## 2. Onboard one real project

Change directory to the target Git repository, then create its local BrainGate identity. Example for Waslo:

```bash
node "$BRAINGATE" init --project-id waslo --name "Waslo"
```

This creates `.brain/project.json` and adds `.brain/` to the repository's local Git exclude file (`.git/info/exclude`). It does not modify the tracked `.gitignore`.

Re-running the exact same `init` is safe. A conflicting existing project ID/name/repository mapping is refused rather than overwritten.

Suggested distinct IDs for the planned dogfood projects:

```text
waslo
tabaq-ai
saudigpt
viral-x
```

Use lowercase alphanumeric/hyphen IDs only.

## 3. Verify provider discovery

```bash
node "$BRAINGATE" discover --json
```

Check that the CLI you want to use is available and that subscription authentication is reported truthfully. BrainGate does not infer a subscription when discovery cannot prove it.

Do not continue with a provider showing API authentication if your intent is subscription-only execution.

## 4. Configure the local model catalog

BrainGate intentionally does not invent model capability scores, model IDs, context limits, or quota pools. First inspect discovery, then add a scored definition for each model you want the router to use.

Create a local JSON file outside the target repository or under its ignored `.brain/` directory. Example shape for a Claude coding model:

```json
{
  "providerId": "anthropic",
  "modelId": "<MODEL_ID_FROM_YOUR_VERIFIED_SETUP>",
  "quotaPool": "claude-subscription",
  "capabilities": {
    "coder": 95,
    "reviewer": 85,
    "judge": 80
  },
  "speed": "balanced",
  "contextCapacity": 0,
  "writeCapable": true,
  "reasoning": 90,
  "underlyingFamily": null
}
```

Replace `modelId` and `contextCapacity` with values you have verified for the installed provider/model. The placeholder `0` is intentionally not usable as a real capacity.

Then add it:

```bash
node "$BRAINGATE" models add --definition .brain/claude-model.json
```

For Codex as an independent reviewer, add a separate OpenAI definition with `writeCapable: false` and a verified model ID/capacity. Codex remains reviewer-only and must pass the M10 isolation self-test before it can be selected.

Inspect the catalog with:

```bash
node "$BRAINGATE" models list --json
node "$BRAINGATE" models validate --json
```

## 5. Run zero-cost preflight

```bash
node "$BRAINGATE" dogfood preflight
```

Preflight checks:

- project manifest and repository identity
- source checkout cleanliness
- model catalog state
- provider availability/authentication
- read-only primary eligibility
- restricted Claude write eligibility
- reviewer eligibility
- Codex isolation when relevant

It performs zero provider model calls. `ask` and `write` readiness are reported separately.

## 6. First read-only trial

Plan first:

```bash
node "$BRAINGATE" dogfood ask plan --task "Where is the theme configuration defined?"
```

No provider model call happens during the plan.

Execute only after the plan looks correct:

```bash
node "$BRAINGATE" dogfood ask run --task "Where is the theme configuration defined?" --execute
```

The answer is returned to the terminal, while dogfood telemetry stores only sanitized execution metadata.

If you explicitly want optional review for a task whose budget permits it:

```bash
node "$BRAINGATE" dogfood ask run --task "Explain this integration boundary" --review --execute
```

## 7. Label the result

After a completed dogfood run, BrainGate prints its task UUID. Record what the task actually turned out to be:

```bash
node "$BRAINGATE" dogfood feedback \
  --task-id <TASK_UUID> \
  --actual-complexity T1 \
  --outcome success
```

You can also label risk:

```bash
node "$BRAINGATE" dogfood feedback \
  --task-id <TASK_UUID> \
  --actual-complexity T2 \
  --actual-risk medium \
  --outcome partial
```

For a behavior that should become a regression case, add `--regression`.

M12 activates a project/mode prior only after at least three labeled samples and at least 60% underprediction. The prior can only escalate future classifications.

## 8. First small write trial

Start with a harmless T0-T2 change such as copy, a small isolated UI string, or a narrow test-only change. Avoid auth, payments, migrations, security controls, production operations, or destructive changes.

Plan with review disabled for the smallest initial writer smoke test:

```bash
node "$BRAINGATE" dogfood write plan \
  --task "Change the local empty-state label from X to Y" \
  --no-review
```

Execute:

```bash
node "$BRAINGATE" dogfood write run \
  --task "Change the local empty-state label from X to Y" \
  --no-review \
  --execute
```

BrainGate returns the task worktree path and branch. The source checkout remains unchanged. Inspect the diff in that worktree yourself.

Once Codex reviewer isolation is ready on Linux/macOS/WSL, omit `--no-review` to use the configured review path. Native Windows Codex review remains fail-closed in this milestone; WSL follows the Linux path and still has to pass the self-test.

BrainGate does not merge the worktree branch for you in M12.

## 9. Inspect dogfood learning

```bash
node "$BRAINGATE" dogfood report
```

The report includes:

- run and feedback counts
- feedback coverage
- exact / under / over complexity predictions
- regressions
- provider/role counts
- reviewer verdict counts
- active ask/write project priors

It does not contain prompts, model answers, reasoning, or diffs.

## 10. Export sanitized regression metadata

After marking runs with `--regression`:

```bash
node "$BRAINGATE" dogfood export
```

Default output is `.brain/dogfood-regressions.jsonl`, which remains under the project's local ignored `.brain/` directory.

## Recommended rollout across the real projects

Use one project at a time:

1. Waslo — read-only questions first, then 3-5 harmless small writes.
2. SaudiGPT — read-only and isolated UI/config changes.
3. Viral-X — read-only plus narrow non-production Laravel/frontend changes.
4. Tabaq AI — read-only first; keep payments/subscriptions/auth flows out of M12 writes.

For the first 20-30 tasks, label complexity/outcome consistently. Treat every isolation, routing, quota, memory, or classification failure as a regression before widening the write boundary.

## Antigravity under DIRECT

Antigravity's print mode auto-denies every tool that would have prompted, and takes no allow-list per
invocation, so a DIRECT run on it can start only when its own settings allow headless reads and shell
commands (measured on agy 1.2.7: with the read rule alone it still reaches for the shell to read a
file). The rules are the operator's to add, in Antigravity's own file, and BrainGate reads it and never
writes it:

```json
{ "permissions": { "allow": ["read_file(*)", "command(*)"] } }
```

in `~/.gemini/antigravity-cli/settings.json`. Until then `providers list` shows `DIRECT: none` for it with the same instruction, and a
`/use google/...` turn is refused with it. Once the rule is there, Antigravity reads and writes the
workspace like the other three, and its conversation id is resumed across turns (ADR 0020).

## Continuity between runs

A dogfood run is a work unit of a goal. The interactive session keeps a short thread so a follow-up
resolves; the goal keeps what was *established* — accepted findings, disputed claims, files changed,
tests run, open questions — and that is what a later worker is handed, whether it is hours later on
the same model or immediately on a different one. A worker whose own native session can be resumed is
given only what changed while it was away. None of this reaches canonical memory: an answer is a
worker's claim until the operator or the evidence makes it a finding, exactly as before.

## Trying DIRECT execution on a disposable copy

The ordinary loop is: run BrainGate in a directory, ask for something, and see it in your files. Use a
throwaway clone for the first run, and expect uncommitted changes rather than a worktree:

```bash
git clone <repo> /tmp/braingate-direct && cd /tmp/braingate-direct
braingate init --project-id direct-trial --name "Direct trial"
braingate                      # the session; DIRECT is the default policy
```

Inside the session:

```text
/policy                                            the boundary the next run happens inside
/use anthropic/claude-sonnet-5
what does the auth flow do when the session expires?      a read, in your workspace
/use google/<configured-model>
review that answer against the code                        a second opinion, same files
/use anthropic/claude-sonnet-5
implement the smallest fix you proposed                    a write, in your workspace
/policy worktree
the same change again, proposed instead of applied          the strict mode, on request
```

Afterwards, `git status --short` in the clone is the record: BrainGate made no commit, and nothing
was merged. `braingate tasks list` shows the tasks, and their receipts name the policy, the provider
`cwd` and the files each run changed.

### Reading a session listing

`/worker` lists the sessions on record with the envelope each was created under:

```text
  Sessions on record:
    anthropic/claude-sonnet-5 · 8a7862ad · read/direct · told not to modify files · available · last used …
    anthropic/claude-sonnet-5 · abc12345 · write/direct · available · last used …
  A read session is never resumed for a write: the instruction it was created with lasts as long as it does.
```

A read request resumes the read session; a write request gets the write session, or a fresh one plus
the goal handoff if there is none yet. Both belong to the same goal, and the operator repeats nothing.
