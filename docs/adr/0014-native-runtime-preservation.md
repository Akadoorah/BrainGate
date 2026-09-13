# ADR 0014 — Native runtime preservation and policy overlays

Status: accepted (2026-09-13)

## Context

BrainGate launches the AI CLIs the operator already pays for. The first version of that idea put a
BrainGate-owned sandbox in front of every one of them, and the reason was sound: a run BrainGate
starts on the operator's behalf has to be bounded somewhere, and at the time the only boundary
BrainGate could prove was one it built itself.

The consequence was not. By M19 every profile reduced a provider to a guarded reader. Claude ran with
`--no-session-persistence`, `--disallowedTools mcp__*` and an empty MCP configuration. Codex ran
`--ephemeral` with thirty features disabled. Subagents were BrainGate's own declared helpers rather
than the runtime's. A `reviewer` could not reach the network to check a claim, and a `primary` could
not run a shell to run the project's tests, whatever its runtime permitted and whatever the operator
had actually asked for. `docs/MULTI_MODEL_PLAN.md` had already said where that ends: pillar three of
the goal — each model's own tools and subagents — "is not partially available; it is switched off by
construction."

That is the wrong product. The operator can open a terminal and run `claude`, `codex`, `agy` or
`grok` and use them fully; a control plane that cannot is not a control plane over those tools, it is
a worse replacement for each of them. It also makes BrainGate's own guarantees harder to reason
about, not easier: a system that denies everything by default cannot say which denial was a decision
and which was a habit.

## Decision

**The native runtime is the default interactive execution mechanism. BrainGate coordinates runtimes;
it does not replace their harnesses.**

1. **Preserve the native runtime.** If the operator can do it in the provider's own CLI under the
   permissions that CLI asks for, they can generally do it through BrainGate too. BrainGate does not
   disable shell, tools, MCP, subagents, skills, browser, worktrees or the runtime's internal agent
   orchestration merely because it is the one launching the process.

2. **The provider's permission system stays meaningful.** Native approval prompts remain the ordinary
   mechanism for ordinary interactive work. BrainGate does not stand in for them, and it does not
   need to: a human is present, and the runtime's own model is the one the operator already accepted
   by installing and signing into it.

3. **BrainGate adds policy overlays, not a replacement boundary.** An overlay is a constraint applied
   for a stated reason — the operator asked for it, or the execution mode requires it. Every overlay
   is visible in the plan before anything is spent, and every refusal names the policy that caused it.

4. **Strict modes remain available.** Worktree writes, project snapshots, the Grok and Codex sandbox
   attestations and the read-only primary path all stay, as *selectable* execution policies. Snapshot
   and worktree isolation stop being the only way a provider may run.

5. **Roles describe purpose, not a crippled tool surface.** `reviewer` means "check this
   independently", not "text-only worker with most of the runtime switched off". A reviewer may read
   the repository, run the tests, search the web or spawn its runtime's own subagents, while still
   respecting "do not modify source" when that is the boundary the task actually needs.

6. **Native subagents belong to the runtime.** When BrainGate dispatches "implement X" to Claude Code
   and Claude Code decides to use three subagents, a Bash tool and its own tests, that is Claude
   Code's execution strategy. BrainGate accounts for it as **one** top-level dispatch, reads whatever
   usage the runtime reports, and does not micromanage the inside. BrainGate's own multi-model work
   stays coarse-grained: one worker, or a primary and a reviewer, or a council when it is genuinely
   warranted — never every provider on every message.

7. **Native session persistence belongs to the runtime.** Claude keeps its session files where it
   keeps them; Grok keeps its own. BrainGate does not copy a provider's session database, does not
   need to own it, and does not treat its location as a boundary question. Where a runtime offers a
   way to name a session, BrainGate may name one and hold a reference to it. Where it does not,
   BrainGate says so and continues the *work* instead.

8. **BrainGate owns the cross-runtime relationship.** What BrainGate stores is the shared goal and the
   mapping from it to each runtime's own session:

   ```text
   Goal G1  ↔  Claude session C1
            ↔  Grok session G7
            ↔  Gemini conversation A3
            ↔  Codex thread X4
   ```

   A reference is provider, runtime, model, native session id, goal, conversation, workspace, runtime
   version and timestamps. Never a credential, never a copy of the provider's session store, never
   hidden reasoning.

9. **Cross-provider continuity never depends on native resume.** The goal's shared state is
   authoritative. If a native session can be resumed, BrainGate resumes it and sends only what
   changed since that session last participated. If it cannot, BrainGate starts a fresh session and
   sends a bounded goal handoff. A provider that supports neither still continues the goal.

10. **Shared context is not a prompt replay.** BrainGate keeps the raw local history, the structured
    goal state, evidence references and artifact paths, and sends a bounded handoff or a bounded
    delta — never the whole transcript, and never the whole transcript to every model on every turn.

## Classification of the restrictions that exist today

Each is one of: **A** required by the native runtime, **B** required by an explicit operator policy,
**C** required for unattended or autonomous safety, **D** a legacy BrainGate restriction with no
current justification, **E** an optional strict mode.

| Restriction | Class | Where it stands |
|---|---|---|
| Codex `--ephemeral`, `--ignore-user-config` | **A** | Part of the isolation contract the Codex snapshot proof was earned under. Removing it invalidates an attestation, which is a change with its own evidence, not a side effect. |
| Grok sandbox profile; Codex sandbox profile | **A** | The CLIs' own enforcement, proven per run by self-test. Kept. |
| Grok excluded as read-primary (needs the checkout) | **A** | Its sandbox confines it to its own working directory; the snapshot-read mode is what removes the reason. Kept. |
| Provider-scoped data isolation | **A/B** | ADR 0002. Non-negotiable, and unrelated to tool breadth. |
| Read-only primary without shell | **D** (interactive) / **C** (unattended) | No current justification for denying a read-only run the shell its runtime would give it. Lifting it is the next slice, with a read-only-repository overlay rather than a blanket denial. |
| Universal MCP refusal | **D** (interactive) / **C** (unattended) | Contradicts preservation. Replacing it needs a per-server policy — which servers, reaching what — not a switch from "none" to "all". |
| BrainGate-declared subagents instead of native ones | **C/D** | The declarative path exists because BrainGate wants helpers that inherit the run's boundary. It should be an option, not the only way helpers can exist. |
| `--no-session-persistence` on Claude | **D** (was) | **Removed in this slice.** It is now applied only when a run is not continuing a session, which is the runtime's own default for ordinary use. |
| Snapshot / worktree / strict isolation | **E** | Kept, and selectable. |
| Budget, turn ceilings, concurrency ceilings | **B/C** | The operator's spend and runaway bounds. Kept. |

Only the last line of that table is a brain-gate-*must*; the D rows are work, and each is named here
so the next slice is a decision rather than a discovery.

## Consequences

- **Preservation raises the value of the attestations, not lowers it.** A runtime that enforces its
  own boundary is the reason BrainGate can let it run normally. Where enforcement cannot be proven,
  the operator's recorded acceptance (ADR 0008) is what stands in — and it is still required.
- **Native session continuity becomes per-runtime and per-mode.** A session is continued where the
  runtime permits naming one and where the working directory this run would use is the one the
  session belongs to. Otherwise a fresh invocation with the goal handoff, reported as such.
- **`resumeMode` is recorded, never assumed.** A session the runtime may not be able to continue is
  written down as such rather than believed to be resumable.
- **Accounting gets coarser and more honest.** One top-level dispatch may cover many internal agent
  executions. BrainGate reports what the runtime says it spent (ADR 0012) and does not invent a
  count it cannot see.
- **The plan is where an overlay becomes visible.** Every granted capability and every refusal already
  rides on the plan; that is now the surface where "you asked for read-only" and "this mode needs an
  isolated workspace" are distinguishable from "BrainGate always does this".

## What this ADR does not do

It does not widen a single tool surface by itself. It changes what the *defaults mean* and what a
future widening has to justify, and it removes one restriction — `--no-session-persistence` — whose
only reason was a policy that no longer exists. Every D row above still behaves as it did before this
ADR until a slice changes it, and that slice owes its own tests.
