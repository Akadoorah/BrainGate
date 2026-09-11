# ADR 0011: A run's record is finalized through one ordered path, and repaired by reconciliation

Status: Accepted

## Context

A task's record lives in three places that cannot be written together:

- `tasks.sqlite`, the ledger: states, events, usage;
- `dogfood.sqlite`, the corpus: what the run observed, for measurement and for priors;
- the result files on disk: the answer, or the guarded diff.

Every one of those stores is opened with `journal_mode = WAL`, because concurrent readers are the
normal case here — `status`, the dashboard and a running task all read while work is written. WAL
buys that, and it costs atomic commit *across* databases: SQLite only guarantees it when the journal
mode is not WAL. There is therefore no transaction that can span all three, and pretending otherwise
would be a lie in the one place the project can least afford one.

The consequence was visible in daily use. A run that died between writing its answer and recording
it left a task `running` forever; a task whose provider refused mid-flight could end terminal with
no observation and no result claim; a corpus could hold a run whose ledger row and result file had
never existed. The ledger was, from the operator's side, write-only: `status` printed one line per
task and no command could answer "what happened to this task" or "is anything half-written".

Two failure modes had to be separated, because they have different evidence:

1. **Finalization began and did not finish.** A result file exists, or `task.result` was appended, or
   an observation was written. Any one of those proves the run is over, so waiting is pointless —
   repair immediately.
2. **No evidence at all, on a task the ledger still calls non-running-terminal.** Only here can a run
   plausibly still be working, so only here is a wait justified.

## Decision

**One ordered path, and a reconciler that can finish any prefix of it.**

`finalizeTask` in `@braingate/core` performs six steps in a fixed order, each idempotent:

1. compose the plan in memory (outcome, review status, failure kind, basis, result, observation);
2. write the result file — the only artifact that cannot be recomputed, so it goes first;
3. append `task.result` — the durable claim that the file exists and what it hashes to;
4. append the observation, through the seam;
5. append `task.finalized` — the marker, carrying an evidence snapshot;
6. perform the terminal transition, last, because a terminal task is what every reader treats as
   finished.

A crash at step *n* leaves a prefix, and `reconcile` in the same package completes any prefix. The
order is what makes that safe: a claim never precedes its artifact, and a marker never precedes the
claim it summarises.

**The result is a content-addressed file, not a row.** `<kind>.<sha256-of-stored-bytes>.<ext>`. The
name states what the file must contain, so a retry after a crash either finds the identical file and
verifies it, or writes a different name; nothing is ever overwritten. `locate()` re-hashes every file
in a task's directory and reports which ones no longer match — a torn artifact is discarded, and a
valid one with no `task.result` claim is adopted, with `evidence: "recovered"`, so the record says
"discovered" rather than "written by this finalizer". The ledger itself holds metadata only: it is
read whole by `tasks show`, by the dashboard and by every export, so a preview of the content would
put every task's bytes into the one store that is copied around.

**Two recovery classes, and only one of them waits.** `inspectReconciliation` reports
`partialFinalizations` (repaired at once) and `staleNonTerminal` (repaired past a bound). The bound
is derived, not authored: `3 × MAX_PROVIDER_CALL_MS`, because no provider call can outlive the
ceiling the executors enforce, so nothing silent for three of them can still be working.

**Reconciliation is a writer, and a reader's question.** `braingate tasks reconcile` repairs;
`status`, `tasks list`, `tasks show` and `doctor` only *report* `Reconciliation required: N task(s)`
through `inspectReconciliation`, and append nothing.

**An existing snapshot is not re-derived.** If `task.finalized` is present, a reconciler completing
the remaining steps adopts the recorded outcome instead of deriving a second one. Two derivations of
the same evidence are two answers waiting to disagree, and the disagreement would be visible: a
marker saying SUCCESS with a transition payload saying something else.

**The seam keeps the layering.** `TaskFinalizer`, the vocabularies and the result store live in
`@braingate/core`. The composition — ledger, project-local result directory, corpus — happens at the
CLI edge. An execution package that imported the measurement store to write its own record would be
the wrong shape, and now cannot be.

## Consequences

- A task execution cannot be recorded *partially* in a way nobody notices: every task the runner
  creates is finalized, because the runner cannot be constructed without a `TaskFinalizer`, and the
  observation context is a required parameter rather than an optional one.
- A reconciled run is recorded in the corpus with `reconciled: true` and is excluded from priors and
  from the live outcome counters. Its roles and its use of a prior are reconstructions, and a corpus
  that let them move the next routing decision would be measuring its own repairs.
- The outcome of a crash at the result-file step is INTERRUPTED, not SUCCESS, even though an artifact
  exists: the artifact proves the run produced something, not that the work succeeded. Only a marker
  says how the work went.
- The corpus schema gained `failure_kind` and `reconciled`, and its outcome vocabulary widened to
  include `interrupted` and `unknown`. SQLite cannot alter a CHECK constraint, so the table is
  rebuilt around its own name with `foreign_keys = OFF` for the duration and `foreign_key_check`
  afterwards; `sequence` values are carried across unchanged, because renumbering them would rewrite
  the order of the corpus.
- `dogfood_runs.outcome` is validated against core's exported `OBSERVATION_OUTCOMES` and the CHECK
  constraint is generated from the same list, so the guard and the schema cannot drift.
- Reconciling is not free: it appends events to the ledger of a task the operator may have been
  reading. It is therefore never triggered implicitly by a read-only command.
