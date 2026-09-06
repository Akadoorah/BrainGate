# ADR 0004: Canonical memory is validated, project-scoped, and single-writer

Status: Accepted

## Decision

Workers cannot directly write canonical memory. They submit proposals containing source evidence, project scope, confidence, related files/commits, and retention type. A single validation path accepts/rejects/supersedes canonical records.

Canonical architecture decisions and business rules do not expire automatically. Session scratch and temporary observations have bounded retention.

## Consequences

Conversation compaction or worker replacement cannot erase authoritative project knowledge, and conflicting worker opinions do not silently become facts.
