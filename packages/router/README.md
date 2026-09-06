# @braingate/router

Deterministic capability- and quota-aware model selection.

Model IDs are opaque provider-owned strings. BrainGate routes on stable capabilities, task complexity/risk, context capacity, write support, runtime availability and quota pressure. Unknown quota is penalized rather than treated as free; exhausted quota is excluded.

GitHub Copilot remains its own provider/quota pool even if an underlying model family resembles a model available directly from Anthropic, OpenAI or Google.
