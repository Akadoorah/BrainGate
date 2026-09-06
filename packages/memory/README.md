# @braingate/memory

Project-scoped canonical memory independent of provider sessions.

Workers can only create immutable proposals. A supervisor review must approve a proposal before it becomes canonical and searchable. Canonical records, proposals, and review decisions are append-only/immutable at the SQLite layer; corrections are represented by superseding records rather than edits.

Each registered project receives its own `memory.sqlite` under its isolated BrainGate storage directory.
