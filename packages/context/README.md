# @braingate/context

Deterministic bounded context-pack construction.

A ContextBuilder is bound to exactly one registered project and that project's canonical memory. It accepts only explicit code/history/instruction candidates, rejects cross-project candidates, deduplicates them, retrieves a small number of relevant canonical memory records, and enforces a conservative hard context budget.

There is intentionally no whole-repository fallback.
