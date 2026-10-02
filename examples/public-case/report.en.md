# APIPatch — analysis report

ID: report\_a2f064c00506c5a512189b9c

Old OpenAPI: examples/public-case/old.yaml (931dcd5d7262928fc5ae42a5737537ef740a2b430f8cf0056f421caeae313130)

New OpenAPI: examples/public-case/new.yaml (e792f27c81dbfcc0eeaef723ac6a26b7e594b42c97d621b1224c1d234983bd32)

Repository: ./examples/public-case

## API changes

| Classification | Method | Path | Rule | Explanation |
| --- | --- | --- | --- | --- |
| compatible | GET | /orgs/{org}/roles/{role\_id}/teams | operation.added | New operation GET /orgs/{org}/roles/{role\_id}/teams. |
| breaking | GET | /orgs/{org}/security-managers/teams | operation.removed | Operation GET /orgs/{org}/security-managers/teams no longer exists in the new contract; requests to it may fail. |

## Affected uses

| Location | Operation | Confidence | Consequence | Review |
| --- | --- | --- | --- | --- |
| consumer.js:3:26 | GET /orgs/{org}/security-managers/teams | high | Potential break: Operation GET /orgs/{org}/security-managers/teams no longer exists in the new contract; requests to it may fail. | pending |

## Repairs and verification

Plans: 0. Checks: 0.


## Limitations

- Schema comparison covers a documented subset of JSON Schema; composition \(allOf/anyOf/oneOf/not/if-then-else/discriminator\) and uninterpreted keywords are reported as ambiguous when they change, never as safe.
- Operations are matched by HTTP method and path template; renamed operations, parameters and properties are reported as removal plus addition and never inferred from similar names.
- Security compares effective requirement names and scopes only; security scheme definitions \(type, location, flows\) are not part of the snapshot and are not compared.
- Parameter style/explode, encoding, response headers, links and callbacks are not part of the snapshot and are not compared.
- Evidence pointers inside schemas are relative to the normalized \(dereferenced\) schema; source locations point to the enclosing parameter, media type, response or operation.
- Recursive schema back-references are compared by reference text only.
- OpenAPI 3.0 nullable and boolean exclusiveMinimum/exclusiveMaximum are normalized against 3.1 type unions and numeric bounds; other dialect differences \(for example nullable inside a 3.1 document\) are treated as uninterpreted keywords.
- Several media type keys that collapse after removing parameters are reported as ambiguous instead of silently selecting one schema.
- Static analysis only: unknown wrappers, computed properties, mutable values and complex data flow require review.
- Response properties are traced only through immutable direct response variables and fetch json\(\) variables.
- Exported URL expressions and scanned values are redacted; inspect the local source at the reported coordinates.

Passing local checks does not demonstrate production compatibility.
