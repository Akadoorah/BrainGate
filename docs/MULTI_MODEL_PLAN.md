# Plan: every subscription, every model, at its strongest

## The goal

BrainGate should route each task to the model that is genuinely best at it — planning, coding,
review, judgement, visual work — across all four subscriptions the operator pays for: Anthropic,
OpenAI, xAI (Grok) and Google (Antigravity), with GitHub Copilot as a fifth path. Each of those
CLIs ships tools and subagents of its own, and BrainGate should be able to spend that power
rather than strip it. The result should not feel like a weaker Claude Code; it should be the
thing Claude Code cannot be — one terminal session that moves each step of the work to whichever
subscription does it best, and hands back a receipt saying so.

This document is the route from where the repository actually is to that, without abandoning
what makes it trustworthy.

## Where BrainGate stands

Through Milestone 13 the control plane is complete and honest: classification, budgets,
project isolation, memory, worktrees, capability routing, reviewer independence tiers, receipts,
quota telemetry. What is narrow is the *provider surface underneath it*.

Measured in the source on 2026-09-09:

| Provider | Roles reachable today | Workspace | Tools granted |
| --- | --- | --- | --- |
| Anthropic (claude) | every role, incl. write | project / task worktree | `Read,Glob,Grep`; no MCP, no shell, no subagents |
| OpenAI (codex) | reviewer only (`SHADOW_CODEX_ROLE_DENIED`) | staged-clean | read only, `--strict-config` |
| xAI (grok) | planner, reviewer, judge (`stagedRoles`) | staged-clean | `--no-subagents`, `--disable-web-search`, `--no-plan` |
| Google (agy) | none — `enabled: false` | staged-clean | reachable only via operator acceptance |
| GitHub Copilot | staged roles | project | `view,grep,glob`; every other tool denied |

So four of the six router roles have exactly one provider that can fill them, `coder` among
them. "Route by capability" is real code, but with one candidate per role it has nothing to
choose between — which is why the pool-distribution thesis has not paid off yet.

## The four gaps between here and the goal

1. **Write is single-provider.** `assertClaudeWriteEligible` refuses anything but Anthropic:
   *"M11 permits Claude Code as the only write-capable primary provider."* That was the correct
   scope for M11. It is now the main reason work concentrates on one subscription.
2. **Tools and subagents are closed everywhere.** Every profile reduces the provider to a reader.
   `--no-subagents`, `--disallowedTools mcp__*`, `--deny-tool shell`. Pillar three of the goal —
   each model's own tools and subagents — is not partially available; it is switched off by
   construction.
3. **The output contract is prompt-negotiated.** `GENERIC_PROMPT` spends eight sentences asking
   for a JSON shape and then parses prose when it does not arrive. Every one of these CLIs now
   accepts a real schema.
4. **Antigravity is absent.** It is `enabled: false` behind a recorded limitation — and that
   limitation is stale (below).

## What the installed CLIs actually offer (measured 2026-09-09, zero model calls)

| | claude 2.1.266 | codex 0.153.4 | grok 1.0.24 | agy 1.1.28 | copilot 0.0.358 |
| --- | --- | --- | --- | --- | --- |
| Structured output | `--output-format json` | `--output-schema <file>` | `--json-schema` | `--json-schema` | — |
| Declared subagents | Agent tool | threads / `exec fork` | `--agents <JSON>`, `--agent` | `--agent`, `agy agents` | `--agent` |
| Bounded write | permission settings | `-s workspace-write` | `--sandbox`, `--worktree`, `--allow/--deny` | `--mode accept-edits`, `--sandbox` | `--allow-tool/--deny-tool` |
| Large input route | stdin | stdin (`-`) | `--prompt-file` | `--input-format stream-json` | `-p` |
| Directory scoping | working dirs | `-C`, `--add-dir` | `--cwd`, `--worktree` | `--add-dir` | `--add-dir` |
| Native review | — | `codex exec review` | — | — | — |

Three facts recorded in the source are now false, and each one currently costs the operator a
capability they are paying for:

- **Antigravity is not argument-only.** `profiles.ts` caps its payload at 100 KB because "agy
  takes its prompt as a command-line argument". `agy 1.1.28` has `--input-format stream-json`,
  which reads NDJSON from stdin. The cap is a limit of an older build.
- **Grok's subagents are configurable, not just disableable.** `--agents <JSON>` accepts inline
  subagent definitions. BrainGate bans them because it could not see them; it can now *define*
  them, which is a different thing entirely.
- **Codex reviewer-only is BrainGate policy, not a Codex limit.** `exec -s workspace-write`
  with `--add-dir` is a bounded write surface, and `codex exec review` is a purpose-built
  reviewer this repository does not call.

Per `AGENTS.md`, each of these is a measurement with a date, not a standing fact — including
this table. The first milestone below exists so the next one does not have to be taken on trust.

## The route

Five milestones. Each keeps the pattern the repository was founded on — **prove, then enable**,
never enable and hope — and each is useful on its own if the next one is delayed.

### M14 — Contracts and capability probes ✅

The cheapest milestone and the one everything else stands on.

- Replace the `GENERIC_PROMPT` JSON contract with each CLI's native schema flag, keeping the
  prompt as the fallback for builds that lack one. Fewer parse failures, less prompt overhead,
  and a contract the provider enforces rather than one BrainGate hopes for.
- Move Antigravity to `--input-format stream-json` and delete the 100 KB argument cap.
- Add a dated **capability probe** per CLI: a zero-model-call `--help` read that records which
  flags *this build* accepts, hashed against the version, surfaced as
  `braingate providers capabilities`. Profile constants stop being hand-written facts that rot.
- Exit condition: every provider fact used by a profile has a recorded measurement date and the
  build it was taken from.

*Done. All four schema surfaces verified against the installed CLIs by pinning a model that
cannot exist, so the flags are proven without spending a completion. Antigravity's stdin route
is measured end to end, including the two shapes the first attempt got wrong.*

### M15 — Tool grants earned per role ✅

Today `guarantees` is a static record per provider: the union of what each profile happened to
disable. It cannot express "this planner may search the web" or "this coder may run the test
command", so the answer to every such question is no.

Replace it with a **grant**: BrainGate states the tools a *role* needs — read, edit, shell, web,
mcp, subagents — each adapter maps that grant to its own CLI's flags, and each level above read
requires a proof bound to version, platform and a hash of the policy it was earned under. That
proof mechanism already exists and works, twice: `codex-isolation.ts` and `grok-isolation.ts`.
This generalises it instead of inventing anything.

**ADR 0010, accepted.** `guarantees` is now derived from the grant and may only be narrowed by
it, never widened — Grok keeps a shell no flag removes, and withholding the capability must not
turn that honest `false` into a comfortable `true`. Refusals carry their reason, and the plan
prints them per role before the run.

### M16 — More than one provider can write ✅

With grants in place, the coder role opens to the providers that can prove a bounded write:

- **Grok** — native `--worktree`, a custom `--sandbox` profile that aborts when it cannot apply
  (ADR 0009), `--deny` rules, `--json-schema`.
- **Codex** — `exec -s workspace-write -C <worktree>`, plus `codex exec review` promoted to a
  first-class reviewer instead of a generic prompt.

ADR 0008 already makes the argument this depends on: what protects the checkout is not the
provider's good behaviour but BrainGate's own outcome checks — task worktree, source
fingerprint before and after, diff guard on every changed path, no merge without a human. Those
apply identically to a second write provider.

Unchanged: high/critical and T3/T4 writes stay human-gated, reviewer independence tiers stay as
they are, and the source checkout stays untouchable.

*Done, and re-measuring Grok first found two things worth the trip: its sandbox event log moved
in 1.0.24, so the self-test had been failing on a file move rather than on a missing protection;
and a custom profile that cannot be applied no longer aborts the run — it warns and continues.
BrainGate reads that warning now, on the self-test and on every real run, and discards the output
of a run that reports it. ADR 0009 records the weaker guarantee rather than restating the old
one. Codex also stopped being reviewer-only: a planner and a judge run in the same staged
workspace under the same attestation.*

*What is left to the operator: the model catalogue still marks only Anthropic models
`writeCapable`, and scores no `coder` capability for Grok or Codex. The code no longer stands in
the way; which models may execute is their decision, recorded in their catalogue.*

### M17 — Subagents as a routing primitive ✅

The router stops selecting only a model and starts selecting a **team shape**: a lead plus a set
of subagents that BrainGate itself defines and whose tool grants are a subset of the lead's.
`--agents <JSON>` on Grok, `--agent` on Antigravity and Copilot, the Agent tool on Claude.

Because BrainGate writes the definitions, fan-out is bounded by the same budget governor and
loop caps that already bound everything else — the subagents are inside the grant, not an
escape from it.

*Done, in two halves. Within a provider: Claude and Grok take definitions BrainGate wrote — a
read-only explorer, and a verifier for review — whenever the grant allows and the budget already
permits more than one agent at once. Grok's `--agents` takes a map, not an array; measured.

Across providers: a task that is worth planning is planned twice, by subscriptions that share no
pool, at the same time. `maxPlanners` is explicit policy rather than a consequence of the
concurrency ceiling, because multi-agent execution is opt-in by rule here — two at T4 and at
critical risk, one at T3, none below. Both approaches reach the executor whole and labelled, with
reconciling them stated as part of the work: summarising would need a third model, and voting
would discard the half that was right about the part the other missed.

Verified against the real CLIs: a T4 task planned by Anthropic and Google in parallel, executed
by Anthropic, reviewed by Codex, with the receipt showing more than one subscription spending a
call.*

### M18 — Antigravity readmitted, and terminal parity ✅

- Re-measure Antigravity's isolation against 1.1.28 under the M14 probe. If HOME scoping is
  still impossible, it stays behind the ADR 0008 acceptance — but with stdin, `--add-dir`,
  `--sandbox` and a schema, so accepting it buys a real worker rather than a crippled one.
- Terminal experience: streaming output, per-project resumable sessions (all four CLIs support
  resume), a visible tool-call timeline, and the plan-then-confirm gate the REPL already has.
  Parity with Claude Code is the floor here; the surplus is the receipt — which provider did
  which step, on which quota, and why the router chose it.

*Done. Antigravity's block was re-measured rather than lifted: an isolated `HOME` still loses
authentication on 1.1.28, so it still runs only on the operator's recorded acceptance — but it
reads from stdin, answers under an enforced schema, and reports its own token counts, so
accepting it buys a real worker instead of a crippled one.

The terminal writes the answer as the model writes it, for the two providers whose stream shape
has been measured. The subtlety is that a provider under a schema does not stream prose: Claude
fills the contract through a tool and streams the human answer, Grok streams the contract JSON
itself, so the readable field is decoded out of it as it arrives. The indicator names the role,
the model and the pool being spent. The thread survives closing the terminal — kept with the
project, redacted, expiring after eight hours, and still not memory.

Two things arrived with the measurements rather than from the plan. Claude publishes a real
remaining balance on every run, which routing now believes in preference to its own account of
its traffic. And letting a role search the web became its own operator decision, because reading
it off the unscoped-provider acceptance granted the network to a provider accepted for an
unrelated reason and withheld it from one that never needed accepting.*

## What does not change

Every invariant in `AGENTS.md` survives this plan intact. No token scraping, no credential
persistence, no cross-project retrieval, no hard-coded model names in routing policy, council
still opt-in, no writes to a registered project's primary checkout, usage labels unchanged.

Two things are worth stating plainly, because this plan widens what providers may do:

- **Wider grants mean more proof, not less.** Every capability opened above read is opened by a
  self-test bound to a version, a platform and a policy hash — so a provider update invalidates
  it without anyone remembering to.
- **A fake executor cannot see any of this.** Every milestone here lives at the provider
  boundary, which is precisely where the test suite is blind. Each one needs a run against the
  real CLI before it is called done.

## Sequencing

M14 first because it is cheap, reversible, and turns the rest from assumption into measurement.
M15 next because M16 and M17 are both unsafe without it. M16 and M17 are independent of each
other and can be taken in either order. M18 last because it depends on M14's probe to answer a
question that is currently answered by a stale note.
