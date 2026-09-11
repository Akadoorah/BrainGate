# ADR 0012: A quota state is something a provider said, never something BrainGate inferred

Status: Accepted

## Context

Routing needs to know whether a pool is usable, and for a long time the only thing BrainGate could
observe about a provider's subscription was its own traffic. So it derived a status and stored it:

- a call that was served → `healthy`;
- a call that was refused → `exhausted`;
- a utilisation figure the provider reported alongside a served call → `pressure`, which routing read
  as a current level of the pool.

Every part of that is a claim BrainGate is not entitled to make, and the operator's own report shows
what it costs. An Anthropic pool at 47% utilisation was recorded as `healthy` with a `pressure` of
0.47; the next task was dispatched to it, refused in a few seconds, and neither the refusal nor a
failover was ever recorded — because the only writer of routing-relevant quota state ran *after* the
exit-code check that threw on the refusal. A refusal could not record itself.

Two separate errors were live at once. The *value* was derived from the wrong thing: "it served this
call" is not evidence about the next one, and a utilisation ratio is not a statement about whether a
pool will serve. And the *freshness* was absent: a reading from three hours ago was read as though it
described now, though its own window had already reset.

The evidence vocabulary already existed in the repository — `native`, `measured`, `estimated`,
`unknown`, with `unknown` carrying no number — and it was being applied to usage while quota
sidestepped it.

## Decision

**Only a provider's own statement can set a pool's state.**

`quotaFor` in `packages/operator/src/runtime.ts` reads stored readings and sets `quotaState` from
those with `evidence: "native"` only. A row BrainGate derived from its own traffic is history; it is
kept, it is visible, and it does not decide routing. Ignorance is not evidence against a pool either:
the `unknown` state no longer carries a penalty, because demoting a pool nobody has a reading for is a
routing decision made on the absence of information, and the operator pays for those subscriptions
anyway.

**A reading is about a window, and a window that has reset is over.** A row whose `resetAt` has passed
is dropped from the current view rather than aged by arithmetic. No decay formula is invented: a decay
rate BrainGate chose would be a reading it never took, presented with a timestamp.

**What a provider reported is kept as a hint, labelled as one.** The metric is
`window_utilization` — deliberately not `pressure`, which claims to be a current level of the pool and
is refused alongside an unknown status. It is exposed as `quotaHint` with `quotaObservedAt`, and
routing uses it as a small tiebreaker. `recordQuotaReading` writes it with status `unknown`: the
number is real, its meaning for the next call is not known.

**A refusal is evidence, and a refusal that cannot be recorded is worthless.** M19 records a bounded,
redacted failure record for every failed attempt (`failureKind`, exit code, timeout, duration, and
bounded `stderrTail`/`stdoutTail`), and a window the provider itself reported as refused is persisted
as `exhausted` with `native` evidence and its own reset. `exhausted` is never inferred from the text
of an error message.

**The routing decision records the belief it was made under.** The task brief now carries, per role,
the `quotaState`, the `quotaHint` and when it was observed, and the candidates that lost with the
reasons they lost. A refusal is only explicable against what BrainGate believed when it dispatched.

## Consequences

- A pool at 47% utilisation is no longer skipped as though it had refused, and a pool nobody has a
  reading for is no longer demoted behind one that happens to have a status.
- A structured refusal still fails closed: an `exhausted` reading with native evidence excludes the
  provider from routing until its window resets.
- A failed call now has a permanent, bounded record of what the CLI actually said. That record is
  evidence for a human, not an input to a parser: no failure text is pattern-matched into a state.
- The system prompt's rule is enforced mechanically: `usage values` and quota readings are labelled,
  and an `unknown` label cannot carry a number.
- Attestation-style staleness applies to quota too: a recorded limitation is a measurement with a
  timestamp, and the reset in the row is what makes it expire, not anyone's memory of it.
