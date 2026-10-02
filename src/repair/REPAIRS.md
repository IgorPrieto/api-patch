# planRepairs / applyRepairPlan — supported repairs and limits (T4)

Tests: `tests/unit/repair-plan-apply.test.ts`, `tests/unit/repair-compare-integration.test.ts`, `tests/unit/repair-nested.test.ts`; fixtures `tests/fixtures/repair-demo/`, `tests/fixtures/repair-nested/`.

## Migration identifiers (exact match, never inferred)

| Field | Refers to |
| --- | --- |
| `operations[].from` | `ApiOperation.id` in `report.snapshots.old` |
| `operations[].to` | `ApiOperation.id` in `report.snapshots.new` |
| `renames[].operationId`, `values[].operationId` | `ApiOperation.id` in `report.snapshots.new` (destination). Source = old operation mapped to it, or the old operation with the same id when method and route did not change |
| `allowedOrigins` | Empty: no restriction. Non-empty: the call's `use.origin` must be listed, otherwise its findings stay pending |

`ApiOperation.id = stableId('operation', {method, route})`; it does not depend on the file. OpenAPI `operationId` strings are not accepted.

`parseMigration`/`loadMigration` read JSON or YAML (duplicate keys and aliases rejected) and apply the contract validator. `planRepairs` then rejects: unknown operation ids; rename `from` missing in the source operation; rename `to` / value `name` missing in the destination (query parameter, top-level property of a JSON request body or 2xx JSON response, including top-level `allOf`); fields that cannot be verified (e.g. `oneOf` bodies); chained or swapped renames; two renames to the same name; a field both renamed and given a value; values that are not string/number/boolean or violate the declared `type`/`enum`/`const`.

### Nested mappings (`parent`)

`renames[].parent` / `values[].parent` name the property path of the object that holds the key (request/response only; omitted or `[]` = top level). Contradiction checks (same target, chains/swaps, renamed and valued) apply per `operationId` + `location` + `parent`. At plan time, `from` must exist at `parent` in every source operation and `to` / `name` in the destination. The top-level body schema follows the rules above; each nested segment must be a plain object schema reached through `properties`, optionally merged from object-only `allOf` members. A nested path is rejected as unverifiable (`cannot be verified: <path> <reason>`) when a schema on it uses `oneOf`/`anyOf`/`not`, is an array (`items` or `type: array`), has a non-object `type`, declares no properties (`additionalProperties`-only or untyped), keeps an unresolved `$ref`, is recursive, or the path is deeper than 8 segments. Value constraints (`type`/`enum`/`const`) are checked against the nested field schema.

## Supported edits

| Mapping | Edit | Requirements |
| --- | --- | --- |
| Operation `from → to` | Route segments rewritten inside the URL literal; path parameter expressions are kept verbatim | Same HTTP method, same `servers`, same path parameter names; URL is an inline string or template literal without escapes; route segments are literal text and each parameter is one template expression or literal segment |
| Query rename | Parameter name inside the URL literal, or key of an inline axios `params` object | Name is static; not repeated; destination name not already present; no spread/computed members hiding it |
| Query value | `?name=value` / `&name=value` appended to the URL literal, or property added to inline axios `params` | Existing value equal → no-op; different or dynamic → pending; no URL fragment |
| Request rename | Key of the inline body object (`fetch` `body: JSON.stringify({...})`, axios `data` / body argument); shorthand `{ name }` becomes `{ displayName: name }` | Object literal lexically inside the call; no spread/computed members; destination key absent |
| Request value | Property appended to the inline body object, keeping multi-line indentation and the file's quote style | Same as above; existing equal literal → no-op |
| Response rename | `data.old` → `data.new` on accesses bound by the scanner (`const data = await res.json()`; axios `response.data.old`) | Destination is a valid identifier. If the response variable is used in any other way (passed on, element access, destructuring APIPatch does not edit), the finding is `partial` with a caveat |
| Nested request rename / value (`parent`) | Inside the inline body object, nested object literals are followed by static keys along `parent`; the leaf key is renamed (`{ address: { city } }` → `{ address: { town: city } }`) or a value property is added with the same indentation/quote rules | Every segment is a property assignment whose value is an inline object literal; no object on the path has spread/computed members or duplicate keys; destination key absent. A missing segment means the rename is absent (value: failed) |
| Nested response rename (`parent`) | Starting from the scanner-bound response variable (fetch `data`, axios `response.data`), property-access chains are followed (`data.address.city`, `data?.address?.city`, parentheses and `!` are transparent); only the leaf identifier changes | Destination is a valid identifier. Element access anywhere on the path, an object on the path passed on/aliased/used otherwise → caveat, that use is not edited |
| Response destructuring | `const`/`let` object pattern initialised directly from the response variable (or `response.data`): `{ fullName }` → `{ displayName: fullName }`, `{ fullName: n }` → `{ displayName: n }`, defaults kept, nested patterns follow `parent` (`{ address: { city } }` → `{ address: { town: city } }`) | No rest element and no computed key in a pattern on the path, key not read twice, destination not already read in the same pattern. `var`, destructuring assignments, parameter patterns, and a path segment bound to a variable or array pattern → caveat, never edited |

Every edit records the findings and the reason (mapping used). Comments and unrelated formatting are untouched; only the listed spans change.

## Finding outcomes

- `resolved`: the change is covered by applied edits (or the code already satisfies a value mapping).
- `partial`: route updated but another mapping for the call failed, or a response rename has a caveat. A response rename whose only reads are caveated uses (element access, rest/computed destructuring, destructuring assignments, an object on a nested path used otherwise) is `partial` with no edit; at top level a response variable that is only passed on, with no read of the field, stays `absent` as before.
- `pending`: calls with `ConsumerUse.via` (made through a repository wrapper): every finding of the call, with the wrapper name and `file:line`, never edited in this release; ambiguous or compatible changes; rejected-in-review findings are skipped; unresolved or low-confidence calls; unknown method; call bound to zero or several source operations; removed operation without explicit mapping; disallowed origin; stale file (hash differs from the scan); symlinked, binary, non-UTF-8, oversized or non-JS/TS file; call range no longer matches the AST; dynamic or shared URLs/objects; overlapping edits; patched file would gain syntax errors.
- Linking a request/response finding to a mapping uses only structured data: `ApiChange.fieldPath`, parameter source pointers, or a `properties/<name>` segment of a source pointer. A `fieldPath` of length 1 (and pointer-derived names) links only to top-level mappings; a `fieldPath` of length > 1 links only to a mapping whose `parent` equals `fieldPath.slice(0, -1)` and whose `from`/`name` equals the last segment, otherwise it stays pending (`nested field … is outside the supported repair scope: no explicit nested migration mapping …`). Root (`[]`) stays pending. Explanations are never parsed.
- Header, cookie and security changes are never repaired.

## Application safety

- `planRepairs` never writes. The plan id is `stableId('repair', {reportId, migration, files})`; `applyRepairPlan` rejects a plan whose id or unified diff does not match its edits (`PLAN_TAMPERED`), with paths that are absolute, contain `..`, or are malformed (`INVALID_PLAN`).
- The plan ID is a deterministic content hash, not a signature or MAC. It detects inconsistent/corrupted plan files; do not treat a plan supplied by another party as authenticated.
- All files are validated before the first write: no symlink in any path component, realpath inside the repository, regular file, UTF-8 text without NUL, size limit, and `originalHash` matching. A file whose content equals original + edits is reported as `REPAIR_ALREADY_APPLIED` and left untouched; anything else is `REPAIR_CONFLICT`, and nothing is written.
- Each file is written to a temporary file in the same directory (`O_EXCL|O_NOFOLLOW`, original mode, fsync), then identity (dev/inode) and hash are re-checked and the file is replaced with `rename`.
- Atomicity limit: per file only. If a later replacement fails, files already replaced are restored when they still contain exactly what APIPatch wrote (`REPAIR_ROLLED_BACK`); otherwise `REPAIR_ROLLBACK_SKIPPED`. Status is then `conflict`. A process crash between renames is not recoverable automatically; temporary files are named `.<file>.apipatch-<hex>.tmp`.
- Small TOCTOU windows remain between the final re-check and `rename`, and a directory swapped for a symlink after validation is detected only through the inode check.
- Not implemented: binary or non-JS/TS files, method changes, server/base changes, path parameter renames, nested fields through arrays, `oneOf`/`anyOf`, `additionalProperties` or recursive schemas, nested query parameters, response element access, destructuring in parameters/assignments/`var` or with rest/computed members, following aliases of the response or of nested objects (`const a = data.address`), axios `const { data } = await …`, calls made through wrapper functions (`via`), URL concatenation with `+`, URL or object constants declared outside the call.

## Attribution and moved operations
- An edit is planned only when it is attributed to a non-pending finding: either a finding whose structural subjects match the mapping, or an operation-level finding of a call whose operation has an explicit operation mapping. The second kind of edit records `[authorized by operation mapping …]` in its reason.
- An applied mapping with no related finding is not patched. It is listed as `Migration-only mapping … not applied`.
- A moved operation is `resolved` only when every obligation of the destination is shown from the snapshots plus applied explicit mappings. Obligations are required query parameters, required top-level request-body fields, and source success-response fields that are missing or whose schema changed, compared by exact JSON. Otherwise it is `partial`, and the reason lists what was not demonstrated. Names are never matched heuristically. A required top-level request field or a source response field whose schema changed is demonstrated only when replaying the applied, caveat-free explicit nested renames under it (rename the key in `properties` and in `required`, following plain `properties` paths only) on the source schema yields the destination schema (compared with sorted keys and sorted `required`). Nested value mappings do not demonstrate a changed schema, and nested renames are never used for top-level obligations. Header and cookie requirements, other nested changes, and unverifiable schemas are always left partial.
