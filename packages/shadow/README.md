# @braingate/shadow

Subscription-backed, read-only shadow execution for BrainGate dogfooding.

This package is deliberately fail-closed. Automated shadow invocation is enabled only for provider profiles whose per-invocation read-only guarantees have been verified. It never grants project writes, never uses a shell command string, and never treats unknown authentication as a subscription without an explicit short-lived local attestation.
