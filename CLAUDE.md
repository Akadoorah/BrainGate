# Claude Code instructions

Follow `AGENTS.md` as the canonical repository instruction file.

When working on BrainGate:

- Inspect before editing.
- Prefer existing contracts and ADRs over inventing new architecture.
- Keep implementation scoped to the assigned milestone.
- Use tests to prove project isolation, permission enforcement, and routing behavior.
- Do not use or request provider API keys for subscription-mode adapters.
- Do not treat model-generated summaries as canonical truth without validation.

If an implementation conflicts with an accepted ADR, stop and explain the conflict before making a broad architectural change.
