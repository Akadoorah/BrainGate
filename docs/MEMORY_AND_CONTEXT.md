# Canonical memory and context policy

## Source-of-truth order

1. Current repository code and tests
2. Verified canonical project memory
3. Task-local observations
4. Provider/session memory

Provider session history is never canonical project truth.

## Single-writer memory flow

```text
worker observation
      ↓
immutable proposal
      ↓
Brain supervisor verification
   ↙       ↘
reject    approve
             ↓
     immutable canonical record
```

An observation reaches that first box from an import, or from `braingate memory note` — and in
an interactive session, `/remember`. A note is the operator stating something about their own
project in one step, because the alternative was writing a file, previewing it, importing it and
promoting it, which meant nothing was ever recorded and the store stayed empty. A gate nobody can
reach is not a safeguard.

It changes nothing about the gate. A note is a proposal, attributed to the operator rather than
to BrainGate so a model's own output cannot enter this way, and it becomes canonical only through
`memory promote` with explicit evidence. `braingate memory proposals` lists what is waiting.

Approved records cannot be edited in place. A correction is a new verified record with `supersedesId` pointing to the older record. Retrieval automatically excludes expired and superseded records.

## Retention defaults

| Kind | Default TTL |
| --- | ---: |
| architecture_decision | never |
| business_rule | never |
| verified_fact | 180 days |
| task_summary | 90 days |
| known_bug | 90 days |
| incident | 365 days |
| code_reference | 90 days |
| temporary_observation | 30 days |

TTL can be explicitly overridden within the bounded policy when the proposal is created.

## Retrieval

Canonical memory uses project-local SQLite FTS5. Query text is Unicode-tokenized and bounded; at most 20 records can be returned by one search call. Each project has a physically separate `memory.sqlite`.

## Context packs

Context packs never default to the entire repository or all project memory. A pack contains:

- the current task statement,
- a small bounded set of relevant canonical memory,
- explicitly supplied code/file excerpts,
- optionally explicit task-history/instruction candidates.

Every item records its source and why it was included. Candidates are deterministically ordered, deduplicated, and bounded by a conservative estimate of two Unicode characters per token. Oversized items are truncated with an explicit marker; lower-priority items are skipped when the budget is exhausted.

A future provider adapter may apply a stricter provider-specific tokenizer, but it may never expand a pack beyond this BrainGate budget.
