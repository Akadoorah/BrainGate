# ADR 0002: Project identity and storage are isolated by default

Status: Accepted

## Decision

Every registered project receives an explicit immutable `project_id`. Project memory and task data use physically separate local storage where practical. Retrieval requires the active project identity and cross-project retrieval is denied unless a future explicit feature authorizes it.

## Rationale

Projects may contain unrelated architecture, proprietary logic, credentials, and skills. A mere prompt or optional query filter is not a sufficient isolation boundary.
