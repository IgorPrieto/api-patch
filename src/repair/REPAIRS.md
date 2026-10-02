# planRepairs / applyRepairPlan — supported repairs and limits (T4)

Tests: `tests/unit/repair-plan-apply.test.ts`, `tests/unit/repair-compare-integration.test.ts`; fixture `tests/fixtures/repair-demo/`.

## Migration identifiers (exact match, never inferred)

| Field | Refers to |
| --- | --- |
| `operations[].from` | `ApiOperation.id` in `report.snapshots.old` |
| `operations[].to` | `ApiOperation.id` in `report.snapshots.new` |
| `renames[].operationId`, `values[].operationId` | `ApiOperation.id` in `report.snapshots.new` (destination). Source = old operation mapped to it, or the old operation with the same id when method and route did not change |
| `allowedOrigins` | Empty: no restriction. Non-empty: the call's `use.origin` must be listed, otherwise its findings stay pending |

`ApiOperation.id = stableId('operation', {method, route})`; it does not depend on the file. OpenAPI `operationId` strings are not accepted.

`parseMigration`/`loadMigration` read JSON or YAML (duplicate keys and aliases rejected) and apply the contract validator. `planRepairs` then rejects: unknown operation ids; rename `from` missing in the source operation; rename `to` / value `name` missing in the destination (query parameter, top-level property of a JSON request body or 2xx JSON response, including top-level `allOf`); fields that cannot be verified (e.g. `oneOf` bodies); chained or swapped renames; two renames to the same name; a field both renamed and given a value; values that are not string/number/boolean or violate the declared `type`/`enum`/`const`.

## Supported edits

| Mapping | Edit | Requirements |
| --- | --- | --- |
| Operation `from → to` | Route segments rewritten inside the URL literal; path parameter expressions are kept verbatim | Same HTTP method, same `servers`, same path parameter names; URL is an inline string or template literal without escapes; route segments are literal text and each parameter is one template expression or literal segment |
| Query rename | Parameter name inside the URL literal, or key of an inline axios `params` object | Name is static; not repeated; destination name not already present; no spread/computed members hiding it |
| Query value | `?name=value` / `&name=value` appended to the URL literal, or property added to inline axios `params` | Existing value equal → no-op; different or dynamic → pending; no URL fragment |
| Request rename | Key of the inline body object (`fetch` `body: JSON.stringify({...})`, axios `data` / body argument); shorthand `{ name }` becomes `{ displayName: name }` | Object literal lexically inside the call; no spread/computed members; destination key absent |
| Request value | Property appended to the inline body object, keeping multi-line indentation and the file's quote style | Same as above; existing equal literal → no-op |
| Response rename | `data.old` → `data.new` on accesses bound by the scanner (`const data = await res.json()`; axios `response.data.old`) | Destination is a valid identifier. If the response variable is used in any other way (passed on, destructured, element access), the finding is `partial` with a caveat |

Every edit records the findings and the reason (mapping used). Comments and unrelated formatting are untouched; only the listed spans change.

## Finding outcomes

- `resolved`: the change is covered by applied edits (or the code already satisfies a value mapping).
- `partial`: route updated but another mapping for the call failed, or a response rename has a caveat.
- `pending`: ambiguous or compatible changes; rejected-in-review findings are skipped; unresolved or low-confidence calls; unknown method; call bound to zero or several source operations; removed operation without explicit mapping; disallowed origin; stale file (hash differs from the scan); symlinked, binary, non-UTF-8, oversized or non-JS/TS file; call range no longer matches the AST; dynamic or shared URLs/objects; overlapping edits; patched file would gain syntax errors.
- Linking a request/response finding to a mapping uses only structured data: `ApiChange.fieldPath` (length 1), parameter source pointers, or a `properties/<name>` segment of a source pointer. Root (`[]`) and nested paths stay pending. Explanations are never parsed.
- Header, cookie and security changes are never repaired.

## Application safety

- `planRepairs` never writes. The plan id is `stableId('repair', {reportId, migration, files})`; `applyRepairPlan` rejects a plan whose id or unified diff does not match its edits (`PLAN_TAMPERED`), with paths that are absolute, contain `..`, or are malformed (`INVALID_PLAN`).
- The plan ID is a deterministic content hash, not a signature or MAC. It detects inconsistent/corrupted plan files; do not treat a plan supplied by another party as authenticated.
- All files are validated before the first write: no symlink in any path component, realpath inside the repository, regular file, UTF-8 text without NUL, size limit, and `originalHash` matching. A file whose content equals original + edits is reported as `REPAIR_ALREADY_APPLIED` and left untouched; anything else is `REPAIR_CONFLICT`, and nothing is written.
- Each file is written to a temporary file in the same directory (`O_EXCL|O_NOFOLLOW`, original mode, fsync), then identity (dev/inode) and hash are re-checked and the file is replaced with `rename`.
- Atomicity limit: per file only. If a later replacement fails, files already replaced are restored when they still contain exactly what APIPatch wrote (`REPAIR_ROLLED_BACK`); otherwise `REPAIR_ROLLBACK_SKIPPED`. Status is then `conflict`. A process crash between renames is not recoverable automatically; temporary files are named `.<file>.apipatch-<hex>.tmp`.
- Small TOCTOU windows remain between the final re-check and `rename`, and a directory swapped for a symlink after validation is detected only through the inode check.
- Not implemented: binary or non-JS/TS files, method changes, server/base changes, path parameter renames, nested fields, response element access or destructuring, URL concatenation with `+`, URL or object constants declared outside the call.

## Attribution and moved operations
- An edit is planned only when it is attributed to a non-pending finding: either a finding whose structural subjects match the mapping, or an operation-level finding of a call whose operation has an explicit operation mapping. The second kind of edit records `[authorized by operation mapping …]` in its reason.
- An applied mapping with no related finding is not patched. It is listed as `Migration-only mapping … not applied`.
- A moved operation is `resolved` only when every obligation of the destination is shown from the snapshots plus applied explicit mappings. Obligations are required query parameters, required top-level request-body fields, and source success-response fields that are missing or whose schema changed, compared by exact JSON. Otherwise it is `partial`, and the reason lists what was not demonstrated. Names are never matched heuristically. Header and cookie requirements, nested fields, and unverifiable schemas are always left partial.
