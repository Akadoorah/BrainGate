# Changelog

Notable changes to BrainGate. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version may change
behaviour, the CLI's flags, or the layout of `~/.braingate`, and the entry here says so.

## [0.1.1-preview] — unreleased

### Fixed

- `/exit` ended the session but not the process: the composer kept listening on stdin, which kept
  Node running until the terminal was closed or Ctrl+C was pressed. The process now exits at once.

### Added

- `docs/demo/`: a VHS tape that records the README's demo GIF from a real session.

## [0.1.0-preview] — 2026-09-25

The first technical preview.

### Added

- **An interactive session** (`braingate`): one conversation and one goal across the provider CLIs
  you already use, with `/use`, `/auto`, `/worker`, `/goal`, `/new` and request history.
- **A first-run wizard** that registers the workspace, adopts the models your subscriptions expose
  with labelled starting scores, and asks at most four questions.
- **Native workers** for Claude Code, Codex, Grok Build and Antigravity in DIRECT mode, and read-only
  Copilot. Codex and Grok earn their roles by a per-run isolation self-test; Antigravity by your
  explicit acceptance.
- **Cross-provider continuity**: a new worker receives the goal; a returning worker resumes its own
  native session where the CLI reports one, and is told only what changed.
- **`/why`**: the route of the last plan, the last run, or a past task, with the winner's reasons and
  every rejection.
- **Big writes are escalated, not refused**: T3/T4 or high-risk writes run in an isolated worktree
  with a reviewer from a different provider, and the merge is yours.
- **Memory with evidence**: `/remember`, `/memory` and `/promote <n> --evidence <file>`, through a
  single validated write path, isolated per project.
- **Streaming** output from Codex and Antigravity while they work.
- **Quota honesty**: usage is labelled `native`, `measured`, `estimated` or `unknown`, and a refusal
  backoff is shown as BrainGate's own decision.
- `braingate --version`.
- The `braingate` package on npm (`npm install -g braingate`), which bundles the CLI and depends
  only on `better-sqlite3`.

### Fixed

- A provider CLI that exited before reading its request crashed BrainGate with an uncaught `EPIPE`.
  The run is now recorded as failed, with the CLI's own exit code and message.

[0.1.1-preview]: https://www.npmjs.com/package/braingate/v/0.1.1-preview
[0.1.0-preview]: https://www.npmjs.com/package/braingate/v/0.1.0-preview
