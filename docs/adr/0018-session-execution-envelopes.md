# ADR 0018 — Native sessions are execution-envelope specific

Status: accepted (2026-09-20)

## Context

A native provider session is not a generic attachment to a model. It is a conversation whose first
message told the CLI what it was for, and the CLI keeps that instruction for the session's whole
life. BrainGate's read profile tells Claude Code, in the run's own prompt, to *"Analyze only; do not
modify files, run commands, access the network, or use external tools."* Claude Code remembers that,
because that is what a session is.

M20.2 stored the reference and resumed it when the provider, model, goal, workspace and runtime
version all matched. That list was incomplete, and real dogfood showed exactly how:

```text
Turn 1  Sonnet, "Inspect this repository … do not modify anything yet."
        → native session 8a7862ad, created read-only
Turn 2  Haiku, "Review the previous worker's recommendation."        → verified
Turn 3  Sonnet, "Tell me what you originally recommended …"          → resumed 8a7862ad
Turn 4  Sonnet, "Apply the agreed harmless comment-only change …"    → resumed 8a7862ad
        → Claude: refused, because its standing instruction says not to modify files
Turn 5  the same request again                                        → the same refusal
```

Every stored field matched. The session was simply created for different work, and resuming it asked
the model to contradict the instruction it had been given. Nothing was damaged — Claude refused
rather than half-executing — but BrainGate had asked for the wrong thing twice, deterministically.

The intent misclassification that produced those turns is a separate defect with its own fix
(`apps/cli/src/request-intent.ts`): a write bounded by "do not commit, do not create a branch" was
read as a read. This ADR is about the layer underneath, which must hold even when the classification
is wrong.

## Decision

**A native session is compatible with a request only when the execution envelope matches.**

1. **The envelope is recorded.** `SessionExecutionEnvelope` carries the requested effect
   (`read`/`write`), the execution policy (ADR 0017), the workflow role, whether the invocation told
   the runtime not to modify anything, and the native permission mode. It is written once, when the
   session is created, and `COALESCE` in the upsert keeps a later use from rewriting it: a session
   that was created for a read does not become a write session by being resumed.

2. **Compatibility is one function.** `sessionEnvelopeReason(stored, requested)` returns the reason
   a session may not be used, or `null`. Any change of intent is refused in both directions;
   policy, role and permission changes are refused; a session with no recorded envelope is resumed
   for a read and never for a write, because a row from before envelopes existed cannot be shown to
   have been created for a change.

3. **Selection is newest *compatible*, never newest.** `latestCompatibleSessionFor` walks the
   sessions for that provider, model and workspace, newest first, and returns the first whose
   envelope matches. A worker may therefore hold several sessions for one goal — a `read/direct` one
   and a `write/direct` one — and each is resumed by the request it belongs to.

4. **Nothing is deleted.** Creating the write session leaves the read session exactly where it was;
   a later read resumes it.

5. **Breaking native continuity must not break goal continuity.** When no compatible session exists,
   the run gets a fresh native session *and* the goal handoff it already carries: objective,
   established findings, files changed, open questions, next action. The fresh write session knows
   what the previous workers concluded without the operator repeating any of it. This is the M20
   architecture being tested by its own failure mode: the native session is a continuity
   optimisation, and the goal is the continuity.

6. **The reason is reported.** The decision carries `envelope-intent-changed` and its siblings, so
   `/worker` can say "fresh native session required — that session was created for a read-only
   request, and this one asks for a change" instead of "fresh, nothing recorded".

## Consequences

- READ → WRITE creates a second native session for the same goal. That is the intended cost: one
  useless refusal prevented, and one handoff paid.
- READ → READ and WRITE → WRITE resume as before, including the returning-worker delta, because
  neither the envelope nor anything else about the session changed.
- A worker switching providers mid-goal (`/use google/…`) still gets a handoff rather than a resume,
  for the reason it always did: a different runtime has no session to resume.
- The envelope is additive and nullable. Sessions recorded before this ADR read as unrecorded, which
  refuses a write and permits a read — the conservative direction, and the one that cannot resume
  into a refusal.

## Alternatives considered

- **Keep one session per (provider, model, goal, workspace) and let the runtime decide.** Rejected:
  the runtime did decide, twice, by refusing — and the operator paid a round trip each time to learn
  something BrainGate already knew.
- **Replace the session on a write, keeping only the newest.** Rejected: the read session's
  conversation is the context a later read wants, and destroying it to make room for a write trades
  a cheap new session for an expensive lost one.
- **Treat a write session as usable for reads.** Rejected as the unsafe direction: a session told to
  apply edits is not the conversation to ask for an independent read, and the asymmetry costs one
  extra session rather than one wrong answer.
