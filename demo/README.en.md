# Synthetic demo

[English](README.en.md) · [Español](README.md)

Run from the repository root after installation:

    apipatch demo --verify-level4

The demo uses the real OpenAPI loader, comparator, AST scanner, migration parser, repair planner, verifier, and apply operation. It runs a consumer against local synthetic v1/v2 APIs on an ephemeral loopback port. Repairs are applied **only to a temporary copy**.

| File | Role |
| --- | --- |
| specs/v1.yaml and specs/v2.yaml | Old and new OpenAPI contracts. |
| repository/client.js | Consumer using fetch with relative URLs. |
| migration.yaml | Confirmed route, query, response, and request-body mappings plus an explicit tenantId value. No mapping for /preferences. |
| harness/consumer-harness.mjs | Runs the consumer in a separate Node process with bounded permissions and a loopback-only fetch harness. |

Expected observed behavior: v1 passes 4/4 cases; the old consumer fails against v2 for GET (404) and POST (400); APIPatch finds five findings, resolves three, and leaves two ambiguous findings pending; /health remains compatible with no false alarm; the repaired temporary copy passes 3/3 supported v2 cases. /preferences remains pending and is not counted as fixed.

The API is handwritten from the demo specifications. Level 4 checks only the packaged synthetic cases and is not a general contract-test generator or production guarantee. On Node versions below 25 the Node permission model does not restrict network access; the demo harness itself confines fetch to the loopback origin. A dynamic base URL remains unresolved and is not repaired.
