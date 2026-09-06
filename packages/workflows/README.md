# @braingate/workflows

Bounded primary/reviewer/judge orchestration built on the deterministic Budget Governor and Capability Router.

This package invokes only an abstract `AgentInvoker`; Milestone 6 tests use fake agents and do not spawn provider CLIs. Review is policy-driven, repairs are bounded, and council/judge execution is disagreement-only for tasks whose budget explicitly permits it.
