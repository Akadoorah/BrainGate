# BrainGate first-trial bootstrap

Use this short checklist after `braingate init` and before the first real dogfood task.

## 1. Check provider/model coverage

Run provider discovery first:

```bash
node "$BRAINGATE" discover --json
```

Import provider-owned model IDs if the CLI exposes them, then add only capability definitions you have verified locally:

```bash
node "$BRAINGATE" models import-discovered
node "$BRAINGATE" models list --json
```

After configuring model definitions, inspect coverage:

```bash
node "$BRAINGATE" models profile
```

The profile reports:

- configured providers and model IDs;
- fast/balanced/deep speed-class coverage;
- whether T0-T4 coding thresholds are covered;
- reviewer-capable model count;
- reviewer independence (`cross-provider`, `same-provider-different-model`, `same-model-fresh-session`, or unavailable);
- quota-pool warnings.

BrainGate does not hard-code Anthropic/OpenAI model marketing names. A single Anthropic subscription can therefore register several provider-owned model IDs under the same real quota pool and let the capability router choose the cheapest sufficient one.

## 2. Preview historical memory

For a project-specific Markdown/text handoff:

```bash
node "$BRAINGATE" memory preview --source ./project-history.md
```

For normalized JSONL:

```bash
node "$BRAINGATE" memory preview --source ./history.jsonl --format jsonl
```

For a local ChatGPT `conversations.json` export:

```bash
node "$BRAINGATE" memory preview --source /path/to/conversations.json --format chatgpt
```

Preview persists nothing.

Do not feed a full multi-project export into one project unless the file has already been scoped to that project. BrainGate intentionally does not guess which project an ambiguous historical conversation belongs to.

## 3. Import as proposals

Once the preview is scoped correctly:

```bash
node "$BRAINGATE" memory import --source ./project-history.md
```

or:

```bash
node "$BRAINGATE" memory import --source /path/to/conversations.json --format chatgpt
```

Import creates **memory proposals only**. It does not create canonical facts.

ChatGPT-style conversations are converted into bounded historical observations rather than storing or injecting the full transcript.

## 4. Promote only verified claims

Use the proposal ID returned by the import and attach real evidence:

```bash
node "$BRAINGATE" memory promote \
  --proposal <PROPOSAL_UUID> \
  --evidence code:src/path/to/file.ts \
  --confidence 0.95
```

You may add multiple `--evidence` values. For an architectural decision supported by Git history, a commit reference can also be supplied:

```bash
node "$BRAINGATE" memory promote \
  --proposal <PROPOSAL_UUID> \
  --evidence adr:docs/adr/001.md \
  --commit <COMMIT_SHA> \
  --confidence 1
```

If a historical claim conflicts with current code, do not promote it as a current fact. Keep it as historical proposal evidence or create a corrected/superseding canonical record through the normal memory path.

Inspect canonical memory with:

```bash
node "$BRAINGATE" memory list
```

## 5. Run zero-cost dogfood preflight

```bash
node "$BRAINGATE" dogfood preflight
```

For a single-provider setup, verify that `models profile` shows the expected T0-T4 coverage. Same-provider review is deliberately labeled weaker than cross-provider review, and critical tasks remain fail-closed without cross-provider review.

## 6. First real task

Start with a read-only question:

```bash
node "$BRAINGATE" dogfood ask plan \
  --task "Where is the theme configuration defined?"
```

If the plan looks correct:

```bash
node "$BRAINGATE" dogfood ask run \
  --task "Where is the theme configuration defined?" \
  --execute
```

Only after a few read-only trials should you attempt the small worktree-only write flow documented in `DOGFOOD.md`.
