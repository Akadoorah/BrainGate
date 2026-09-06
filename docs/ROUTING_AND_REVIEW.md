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
