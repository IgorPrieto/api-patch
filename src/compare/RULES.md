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
| `schema.composition.changed` | ambiguous | ambiguous | allOf/anyOf/oneOf/not/if/then/else/discriminator. Annotation-only `allOf` (3.1 `$ref` + description) is unwrapped first. |
| `schema.keyword.unsupported` | ambiguous | ambiguous | patternProperties, propertyNames, prefixItems, contains, dependent*, unevaluated*, retained recursive `$ref`, 3.1 `nullable`, unknown keywords. |
| (sibling of unchanged composition) | breaking → ambiguous | breaking → ambiguous | Conjunction keeps the direction, but the break is not provable. |
| `schema.depth-limit` | ambiguous | ambiguous | Nesting above 64. |
| `security.authentication.required` | breaking | | Anonymous access removed. Manual intervention; credentials never invented. |
| `security.requirement.unsatisfied` | breaking | | An old alternative no longer satisfies any new alternative. |
| `security.scopes.added` | ambiguous | | Same schemes, more scopes. |
| `security.relaxed` | compatible | | Every old alternative still accepted. |
| `security.unparsed` | ambiguous | | |

Dialects: both 3.0 and 3.1 snapshots, including mixed pairs. Not compared: security scheme definitions, parameter style/explode, encoding, response headers, links, callbacks, deprecation. Full JSON Schema support is not claimed; see `COMPARE_LIMITATIONS` in `index.ts`.
