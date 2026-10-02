# APIPatch architecture

[English](ARCHITECTURE.en.md) · [Español](ARCHITECTURE.md)

APIPatch is a local npm package. The CLI and localhost server call the same modules; JSON reports let users separate analysis, review, and application. The core needs no model, account, or hosted infrastructure.

```text
OpenAPI v1/v2 → openapi → compare ──────────┐
                                            ├→ scan → report
JS/TS repository ───────────────────────────┘           │
                                  confirmed migration → repair → plan/diff
                                                               │
                                                  verify / explicit apply
                                                               │
                                                  CLI and local panel
```

Contracts in `src/contracts` distinguish observed facts (`ApiChange`, `ConsumerUse`, `Finding`), decisions (`MigrationConfig`), and actions (`RepairPlan`). `schemaVersion` identifies persisted formats. Stable IDs and hashes bind files, findings, and proposed edits. Structural validation alone does not prove that a plan is still applicable; application rechecks file hashes.

`src/openapi` loads documents and resolves local references only within a permitted root. `src/compare` classifies changes according to request and response direction. `src/scan` uses the TypeScript AST to associate HTTP operations with consumer code and records confidence and reasons. `src/repair` plans edits from explicit mappings. `src/verify` reports plan validity, syntax, applicable type checks, synthetic contract results, and authorized repository commands by level. `src/report` exports JSON and Markdown. `src/cli` and `src/server` expose these services.

Scanning does not import JS/TS modules or run repository scripts. Unresolved URLs, methods, and transformations require review. Exported reports redact captured URL expressions and values that could contain credentials while retaining source coordinates, operation, evidence, and confidence. Preview and diff do not mutate the consumer. Explicit application checks paths, symlinks, hashes, and conflicts before writing. A proposal that passes checks on a temporary copy has not thereby been applied; an applied plan has not necessarily been verified.

Each `VerificationResult` records level, status, checked properties, evidence, and why a level was skipped or blocked. Level 4 runs only the packaged synthetic demo contract with opt-in and verifies the plan comes from that fixture. Level 5 requires separate authorization for one command, its arguments, and directory. The CLI exits 4 for failed checks and 5 for blocked checks.

The server listens on `127.0.0.1`, bounds file access to the CLI-selected workspace, and requires a session token on API routes. It rejects foreign Host and Origin headers, limits request bodies and paths, and exposes no arbitrary command execution. The panel shows only local-session artifacts. See the [compatibility matrix](COMPATIBILITY.en.md) and [observed validation](VALIDATION.md).
