# Roadmap

## Milestone 0 — Foundation

Architecture, security boundaries, ADRs, repository conventions, and minimal monorepo scaffold.

## Milestone 1 — Project and task core

Project Registry, immutable project IDs, SQLite storage, Task Ledger, event model, and deterministic task lifecycle.

## Milestone 2 — Classification and budgets

Complexity/risk classifier, escalation/de-escalation, Budget Governor, loop caps, and policy tests.

## Milestone 3 — Provider discovery

Official CLI adapters for Claude Code, Codex, Antigravity, Grok Build, and optional GitHub Copilot CLI; install/version/model discovery and normalized telemetry. Discovery is zero-prompt and never intentionally consumes model tokens or AI credits. No code-writing automation yet.

## Milestone 4 — Context and memory

Bounded project retrieval, context packs, canonical memory validation, retention policy, and project-level physical isolation.

## Milestone 5 — Safe execution

Skill Firewall, Secret Guard, Git worktrees, process permissions, read/write execution profiles, and verification hooks.

## Milestone 6 — Routing and review

Capability-based model routing, primary/reviewer workflows, bounded repair, disagreement detection, and optional council/judge.

## Milestone 7 — Dashboard

Task briefs, live execution status, task receipts, audit events, provider quota telemetry, and native/measured/estimated/unknown usage labels.

## Milestone 8 — Dogfood hardening

Shadow/read-only deployment against multiple real projects, then worktree-only writes, then progressively higher-risk tasks. Every failure becomes a regression test.

## Later

Visual/image workers, visual QA, remote control, encrypted sync, teams, plugin/skill marketplace, and enterprise policy features.
