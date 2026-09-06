# BrainGate local dashboard

A dependency-light, local-only dashboard renderer/server for BrainGate observability snapshots.

- Default host: `127.0.0.1`
- Non-loopback binds are rejected.
- Rendering never launches provider CLI probes.
- Unknown quota stays visibly unknown; provenance is always shown.

The app intentionally accepts an already-built `DashboardSnapshot`; collection and provider probing remain outside the rendering path.
