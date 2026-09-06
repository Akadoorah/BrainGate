# @braingate/security

Deterministic secret/path/environment guards used before context inclusion and child-process execution.

This package blocks common credential paths, detects path escapes through canonical realpaths, redacts common token/key formats from captured output, and constructs an allowlisted child environment. Direct-API billing overrides are always stripped in subscription mode.

It is defense in depth, not a claim of complete secret detection.
