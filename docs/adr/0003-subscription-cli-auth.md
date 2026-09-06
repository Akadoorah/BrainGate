# ADR 0003: Provider access is subscription-first through official CLIs

Status: Accepted

## Decision

The default provider mode invokes supported official CLIs using the user's existing account login/session. BrainGate does not extract credentials, scrape OAuth tokens, call private provider endpoints, pool accounts, or circumvent rate limits.

API mode, if ever supported, must be explicit and separate from subscription mode.

## Consequences

Adapters must tolerate provider CLI/version changes and differences in available telemetry. BrainGate may report quota as unknown rather than fabricate precision.
