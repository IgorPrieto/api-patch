# compareApis — rule matrix (T2)

Directional principle: a request change is **breaking** when the new contract rejects something the old one accepted (narrowing); a response change is **breaking** when the new contract may return something the old one did not promise (widening). The opposite moves are **compatible**. Changes whose effect the contract cannot prove are **ambiguous**. Tests: `tests/unit/compare-apis.test.ts`, fixtures `tests/fixtures/compare-*`.

| Rule | Request | Response | Notes |
| --- | --- | --- | --- |
| `operation.removed` | breaking | — | Method + path template. Method change = removal + addition; evidence notes same path / same operationId without mapping it. |
| `operation.added` | compatible | — | |
| `operation.path-template.renamed` | compatible | — | Path parameter names only (`/a/{id}` → `/a/{key}`); path parameters matched by position. |
| `operation.servers.removed` | ambiguous | — | |
| `parameter.added.required` / `.optional` | breaking / compatible | — | Header names case-insensitive. |
| `parameter.became-required` / `-optional` | breaking / compatible | — | |
| `parameter.removed` | ambiguous | — | Spec does not prove rejection. |
| `request.body.added-required` / `-optional` | breaking / compatible | — | |
| `request.body.became-required` / `-optional` | breaking / compatible | — | |
| `request.body.removed` | ambiguous | — | |
| `{request,response}.media-type.removed` | breaking | breaking | Media types compared without parameters, case-insensitive. |
| `{request,response}.media-type.added` | compatible | ambiguous | Response: consumers without content negotiation may receive it. |
| `{request,response}.media-type.generalized` | compatible | ambiguous | Specific type now only covered by a range (`application/*`). |
| `response.status.removed` | — | ambiguous (1xx–3xx) / compatible (4xx, 5xx, default) | |
| `response.status.added` | — | ambiguous (1xx–3xx) / compatible (errors) | |
| `response.status.generalized` | — | ambiguous | `200` now only `2XX`; schemas still compared. |
| `response.body.removed` / `.added` | — | breaking / compatible | |
| `schema.type.narrowed` / `.widened` | breaking / compatible | compatible / breaking | `integer` ⊂ `number`; missing `type` = any. |
| `schema.type.changed` | breaking | breaking | Disjoint change in both directions; deeper comparison stops. |
| `schema.nullable.added` / `.removed` | compatible / breaking | breaking / compatible | 3.0 `nullable: true` ≡ 3.1 `type: [..., 'null']`. |
| `schema.enum.values-added` | compatible | breaking | Exhaustive consumers. `const` treated as one-value enum. |
| `schema.enum.values-removed` | breaking | compatible | |
| `schema.enum.narrowed` / `.widened` | breaking / compatible | compatible / breaking | Enum constraint added / removed. |
| `schema.required.added` | breaking | compatible | Request ignores required `readOnly`; response ignores required `writeOnly`. |
| `schema.required.removed` | compatible | breaking | Response: guarantee withdrawn. |
| `schema.property.removed` | ambiguous (breaking if `additionalProperties: false`) | breaking if it was required, else ambiguous | No rename inference. |
| `schema.property.added` | compatible (optional) | compatible; ambiguous if old `additionalProperties: false` | New required request property reported as `schema.required.added`. |
| `schema.additional-properties.narrowed` / `.widened` | ambiguous / compatible | compatible / ambiguous | Only affects undocumented properties. |
| `schema.range.*`, `schema.length.*`, `schema.item-count.*`, `schema.property-count.*`, `schema.multiple-of.*`, `schema.pattern.*`, `schema.unique-items.*`, `schema.items.*` | narrowed: breaking; widened: compatible | narrowed: compatible; widened: breaking | 3.0 boolean and 3.1 numeric `exclusiveMinimum/Maximum` both supported. Pattern/multipleOf replacements without provable inclusion → `*.changed` ambiguous. |
| `schema.format.changed` | ambiguous | ambiguous | Format assertion is implementation-defined. |
| `schema.read-only.changed` / `schema.write-only.changed` | ambiguous | ambiguous | Only the keyword relevant to the direction. |
| `schema.default.changed` | ambiguous | — | |
| `schema.composition.changed` | ambiguous | ambiguous | oneOf/not/if/then/else/discriminator, allOf that cannot be merged exactly, anyOf changes other than the shapes below. Annotation-only `allOf` (3.1 `$ref` + description) is unwrapped first. |
| (allOf merged) | normal rules | normal rules | Object-like branches merged exactly (see Composition); changes inside get their own rule and `fieldPath`. |
| `schema.any-of.branch-added` | compatible | breaking | Every old branch kept unchanged; no `$ref` in any branch. |
| `schema.any-of.branch-removed` | breaking | compatible | Every new branch was an old branch; no `$ref` in any branch. |
| (anyOf, same branch count) | breaking → ambiguous | breaking → ambiguous | Branches compared pairwise by position; compatible moves stay compatible, breaking moves of one branch may be covered by another. |
| `schema.recursion.unresolved` | ambiguous | ambiguous | A retained recursive `$ref` whose target cannot be found among its enclosing schemas (e.g. a snapshot without anchors). |
| `schema.keyword.unsupported` | ambiguous | ambiguous | patternProperties, propertyNames, prefixItems, contains, dependent*, unevaluated*, a recursive `$ref` facing an unresolvable one, 3.1 `nullable`, unknown keywords. |
| (sibling of unchanged composition) | breaking → ambiguous | breaking → ambiguous | Conjunction keeps the direction, but the break is not provable. Does not apply to a merged allOf (the merge is exact). |
| `schema.depth-limit` | ambiguous | ambiguous | Nesting above 64. |
| `security.authentication.required` | breaking | | Anonymous access removed. Manual intervention; credentials never invented. |
| `security.requirement.unsatisfied` | breaking | | An old alternative no longer satisfies any new alternative. |
| `security.scopes.added` | ambiguous | | Same schemes, more scopes. |
| `security.relaxed` | compatible | | Every old alternative still accepted. |
| `security.unparsed` | ambiguous | | |

## Recursion

The loader (`src/openapi`) retains a `$ref` that closes a schema cycle as `{ $ref }` (3.1 siblings of such a reference are kept as `allOf: [{ $ref }, siblings]` instead of being dropped) and marks every expansion of a recursion target with the annotation `x-apipatch-recursion-anchor: [{ key, refs }]` (target `file#pointer` and the reference texts that point back to it). `x-` keys are annotations, so the `ApiSnapshot` shape is unchanged.

The comparator resolves a retained reference to the nearest enclosing schema on the same side whose anchor lists that reference text; if two enclosing anchors with different keys claim the text, or none does, it is unresolvable. Comparison is coinductive: a visited set of (old target, new target, direction, composed) pairs is assumed equal on revisit, so cycles (including mutual recursion) terminate and each difference is reported once, at the first (shallowest) path where it is reached. `MAX_SCHEMA_DEPTH` (64) still applies along every path (`schema.depth-limit`). Identical subtrees are only skipped when they contain no `$ref`, because equal reference text does not prove equal targets. An unresolvable reference is ambiguous (`schema.recursion.unresolved` if unchanged, `schema.keyword.unsupported` otherwise), never silent. Evidence pointers below a followed reference continue the walked path and may not exist in the normalized schema; `fieldPath` is the property path walked and is correct.

## Composition

- **allOf** is replaced by its exact merge when, after resolving recursive references and flattening nested allOf, every branch (and the schema's own keywords) only uses `type: object`, `properties`, `required`, `additionalProperties` and annotations; a property defined in two branches has identical schemas; at most one branch has non-open `additionalProperties`, and that branch declares every property of the other branches. The merge is the property union, required union, `type: object` if any branch has it, and the restricting branch's `additionalProperties`. Under these conditions the merge accepts exactly the instances the allOf accepts, so the normal rules (with their directions and `fieldPath`) apply. A side whose allOf does not meet them keeps `schema.composition.changed`.
- **anyOf** is a union. Same branch count: compared pairwise by position with the composed flag, so a branch moving in the safe direction is compatible and a breaking move is ambiguous. Different count: when one list is the other plus extra branches (canonical equality, no `$ref`), added branches widen and removed branches narrow. Anything else is ambiguous. Other keywords next to a handled anyOf are compared as siblings of composition.
- **oneOf**, **not**, **if/then/else**, **discriminator**: always `schema.composition.changed` when changed (adding a oneOf branch can make an instance match two branches; exclusivity is not proved).

## Remaining limits

allOf branches with other keywords (bounds, enums, items, composition) are not merged; anyOf branches are paired by position, not by best match; oneOf exclusivity is never proved; pointers through followed recursive references or merged allOf are relative to the walked structure, not the source.

Dialects: both 3.0 and 3.1 snapshots, including mixed pairs. Not compared: security scheme definitions, parameter style/explode, encoding, response headers, links, callbacks, deprecation. Full JSON Schema support is not claimed; see `COMPARE_LIMITATIONS` in `index.ts`.
