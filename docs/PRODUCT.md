# Product definition

BrainGate is a local AI engineering control plane for developers who already subscribe to multiple AI coding products.

The user asks BrainGate a question or requests a change. BrainGate identifies the active project, classifies complexity and risk, retrieves only relevant context, allocates a bounded execution budget, selects an available model role, and records the result.

## Primary user experience

The user should not normally need to choose a provider or model. BrainGate exposes intent-oriented commands such as ask, run, review, status, and doctor.

Before medium/high-risk execution BrainGate produces a task brief describing project, classification, planned workers, maximum rounds, skills, permissions, and context budget. After execution it produces a receipt with provider/model roles, files read/changed, tests, retries, usage evidence, and memory updates.

## Non-goals for v1

- Re-selling model access.
- Sharing provider accounts or credentials.
- Autonomous production deployment.
- Automatic merging to protected branches.
- Always-on councils or swarms.
- Cloud sync or marketplace features.
