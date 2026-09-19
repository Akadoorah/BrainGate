# ADR 0020 — Antigravity's DIRECT gate is a reading of its own settings

Status: accepted (2026-09-19)

## Context

ADR [0017](0017-direct-execution.md) made DIRECT the ordinary policy: the runtime keeps its own
harness, in the workspace the operator chose, and the runtime's own permission model decides what a
run may do inside. It listed Antigravity among the runtimes that could not run DIRECT yet, and the
measurement behind that was specific: headless `agy` auto-denies every tool that would have prompted
(`read_file` under `--mode accept-edits`, `--mode plan` and `--sandbox` on 1.2.2; a run that needed
the workspace ended with `denied_actions` and an empty answer on 1.2.7), and it takes no allow-list
per invocation. A DIRECT run has to read the workspace it was pointed at, so with nothing allowed it
cannot start.

The CLI's own answer, printed in its denial, is a rule under `permissions.allow` in the operator's
settings file (`~/.gemini/antigravity-cli/settings.json`), which every `agy` run on the machine
honours. The alternative it also prints is `--dangerously-skip-permissions`, which approves every
tool with no scope anyone can see.

M22 made the route the thing that chooses the worker, and a route that can reach the strongest
planner in the catalogue on a provider the run then refuses is a route that fails after the operator
committed to it. The goal for this milestone is every installed CLI, Antigravity included, reachable
under the ordinary policy without a special case per turn.

## Decision

**Antigravity may run DIRECT exactly when the operator's own Antigravity settings allow headless
reads and headless shell commands. BrainGate reads that file and never writes it, and passes no
permission flag of any kind.**

- The gate is a measurement, not a constant. The capability probe that already reads each CLI's help
  text also reads `permissions.allow` from the operator's Antigravity settings, and reports two
  facts: whether headless reads are allowed (`read_file(*)`, `read_file(/)`, or a path rule the
  workspace is under) and whether headless shell commands are (`command(*)` or a path rule). The
  plan preview, the run, preflight and `providers list` all consult the same reading, so no surface
  offers what another refuses.
- A DIRECT read is offered when both rules are present. Measured 2026-09-19 on agy 1.2.7: with
  `read_file(*)` alone the model still reached for the shell to read a file and was denied, so a
  reads-only rule set is honest but unusable, and the gate says so. The read asks for prose and the
  invoker accepts it as the answer, exactly as for Grok. Its argv is Antigravity's print mode with the
  model, the effort, the conversation to resume when there is one, and the prompt. No `--mode`, no
  `--sandbox`, no `--add-dir`, and never the blanket bypass — under any policy.
- A DIRECT write is offered on the same condition, with `--mode accept-edits` as the edit posture in
  Antigravity's own vocabulary, exactly as `acceptEdits` is for Claude and Grok. Antigravity has no
  worktree write profile, and this ADR does not add one.
- The plan claims only what the rules allow: with the shell rule the gate needs, the plan does not
  claim `noShell`. The workspace guard observes what changed afterwards, as ADR 0017 requires.
- The refusal, when the rule is absent, names the file, the rule and the fact that BrainGate will
  not add it. It is the operator's tool and the operator's decision, and a BrainGate that wrote
  allow-rules into another CLI's settings would be granting itself what only they can grant.

## Consequences

- On a machine whose Antigravity settings allow headless reads and shell commands, Antigravity is a full DIRECT worker:
  routable automatically, selectable by `/use`, resumable by the conversation id it reports, able to
  read and to write the workspace. Its staged roles and its ADR 0008 acceptance are unchanged.
- On a machine without the rule, nothing changes except the message: the refusal now says which line
  to add, where, and what it would open.
- The rule is global to Antigravity, not to BrainGate: once allowed, every headless `agy` run on the
  machine may read and run commands without a prompt. That is the
  operator's trade to make, and the refusal says so before they make it.
- ADR 0017's list of runtimes that cannot run DIRECT loses Antigravity; the list of things it does
  not preserve keeps the headless prompt, which is exactly what the operator's rules answer.
- Provider facts go stale: the rule grammar and the file location were measured on agy 1.2.7 and
  are recorded beside the code that reads them. A later build that moves the file or changes the
  grammar closes the gate again, with the same refusal, rather than opening it on a guess.
