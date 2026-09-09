# Capability routing and bounded review

BrainGate never chooses a model merely because its marketing name is newer or larger. Provider-owned model IDs remain opaque strings. Routing uses stable role capabilities, task complexity/risk, context capacity, write support, runtime availability and quota pressure.

## Quota ownership

Quota belongs to the provider path actually being used. A Claude-family model invoked through GitHub Copilot consumes the Copilot quota pool, not the user's direct Anthropic pool. `underlyingFamily` is advisory metadata only and never merges quota accounting.

Quota states are ranked conservatively:

- `healthy`: normal candidate
- `limited`: eligible with a substantial penalty
- `unknown`: eligible, but never assumed free/unlimited
- `exhausted`: ineligible

## Complexity floors

Higher task tiers require progressively higher capability scores. High/critical risk also raises the floor. Low-complexity work rewards fast sufficient models so strong quota is preserved for harder tasks.

## Independent review

For high/critical tasks, a reviewer must be from a different provider and quota pool than the primary. Lower-risk review prefers independence but may fall back when policy allows it.

## Council

Council is not a default execution mode. T0-T3 budgets currently disable it. T4 allows at most one disagreement-only judge round. The judge is selected with a strong preference for a provider/quota pool distinct from both primary and reviewer.

## Repair semantics

Reviewer findings are bounded before being returned to the primary. If the task budget does not allow another independent review after a repair, BrainGate returns `repaired_needs_review` instead of pretending the repaired work is automatically approved.

## Security gate

This milestone only plans/routes and orchestrates abstract agents. Real provider CLI invokers remain disconnected from write-capable execution until the isolation gate defined in `SAFE_EXECUTION.md` is satisfied.

## Where quota pressure comes from

No provider publishes a remaining balance, so for a long time pressure was `unknown` for every
pool and routing never moved: the strongest model won every role until its pool ran out for real.

BrainGate knows one thing about quota — what it spent itself — and provider token counts are
recorded natively. Pools are therefore compared against each other: the busiest recent pool
scores 1, the quietest 0, and the router leans away from the busy one.

This is a relative signal and is labelled as one. It claims to know no pool's limit.

- A provider that reports a real balance outranks it. The local reading lives under its own
  metric name as `measured`, never as `pressure`, so a receipt can say which was used.
- A pool nobody measured scores `null`, not 0. Codex and Copilot report no token counts, and
  reading silence as "idle" would send them everything.
- One measured pool is not a comparison and produces no signal.

## Which model gets a cheap question

At T0 and T1 the capability floor has already answered "can this model do it". What remains is
which qualifying model to spend, and the answer is the cheapest one — so speed is the deciding
term there, not a tiebreak. Above those tiers the preference inverts: a T2 change and a T3 audit
get the model that is actually better at them, because there the work is what costs.
