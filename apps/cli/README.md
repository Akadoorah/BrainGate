# BrainGate CLI

The local operator entry point for BrainGate. The CLI intentionally separates safe inspection from token-consuming execution.

## Safety rule

`doctor`, `discover`, `models`, `status`, `dashboard`, `shadow plan`, and `shadow run` **without** `--execute` never intentionally make a provider model call. Only `shadow run ... --execute` may invoke a subscription-backed model.

BrainGate never stores provider credentials or raw task prompts in its local catalog/task status. A completed model answer is printed to the current terminal only and is not persisted in Task Ledger receipts.

## Run locally

From the monorepo:

```bash
pnpm install
pnpm --filter @braingate/cli start -- help
```

After linking/installing the workspace binary you can use `braingate ...` directly.

BrainGate state defaults to `~/.braingate`. Override it with `BRAINGATE_HOME=/some/private/path` when needed.

## Project manifest

Create a JSON manifest outside source control when paths are machine-specific:

```json
{
  "project_id": "my-project",
  "name": "My Project",
  "repositories": ["/absolute/path/to/repository"]
}
```

Repository paths are canonicalized. Shadow commands fail closed when the current working directory is outside a registered repository, including symlink escapes.

## Model catalog

BrainGate does not hard-code current provider model names or capability rankings. Configure the models available on your account explicitly.

Copy `examples/model-definition.json`, replace the provider/model/quota-pool IDs with provider-owned values, and score only capabilities you are willing to route to that model. Then:

```bash
braingate models add --definition ./my-model.json
braingate models validate
braingate models list
```

Safe provider model discovery can also add IDs as **unscored** candidates:

```bash
braingate models import-discovered
```

Unscored candidates are never routable until you add a complete scored definition.

## First checks

```bash
braingate discover
braingate doctor --project ./project.json
braingate status --project ./project.json
```

## Shadow mode

Plan only—zero provider model calls:

```bash
braingate shadow plan --project ./project.json --task "Where is the theme configuration?"
```

`shadow run` also remains plan-only unless execution is explicit:

```bash
braingate shadow run --project ./project.json --task "Where is the theme configuration?"
```

Execute a read-only subscription-backed shadow task:

```bash
braingate shadow run --project ./project.json --task "Where is the theme configuration?" --execute
```

For GitHub Copilot only, when BrainGate cannot prove OAuth status through a safe metadata probe, `--attest-copilot-oauth` creates a one-hour local attestation. It does not override explicit API or unauthenticated evidence.

## Dashboard

```bash
braingate dashboard --project ./project.json
```

The dashboard binds to loopback only. Use `--port <number>` to request a specific local port.

Add `--json` to supported commands for machine-readable output. Shadow plan JSON contains classification, budgets, selected model identities, and sanitized invocation previews—but not the raw task/context body.
