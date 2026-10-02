# APIPatch — informe de análisis

ID: report\_f297f0f856738ec6bb25097e

OpenAPI anterior: demo/specs/v1.yaml (af1b0bc8ecdd38de2d77f78c3bb62c73718efb12df443d90d06406f0acd372b7)

OpenAPI nueva: demo/specs/v2.yaml (0ee93021e3a85a87944135d3f86ed6b0bed6417518f294e245616b80f2520588)

Repositorio: ./demo/repository

## Cambios de API

| Clasificación | Método | Ruta | Regla | Explicación |
| --- | --- | --- | --- | --- |
| compatible | GET | /health | parameter.added.optional | New optional query parameter "verbose". |
| compatible | GET | /health | schema.property.added | Optional property "version" was added to the response 200 \(application/json\) schema. |
| compatible | GET | /members/{id} | operation.added | New operation GET /members/{id}. |
| ambiguous | GET | /preferences | schema.composition.changed | Composition keywords changed for the response 200 \(application/json\) schema \(oneOf\); compatibility is not provable and requires manual review. |
| breaking | POST | /users | schema.required.added | New required property "displayName" for the request body \(application/json\) schema: requests valid under the old contract may now be rejected. |
| ambiguous | POST | /users | schema.property.removed | Formerly required property "name" is no longer documented for the request body \(application/json\) schema; the specification does not prove whether the server ignores or rejects it. |
| breaking | POST | /users | schema.required.added | New required property "tenantId" for the request body \(application/json\) schema: requests valid under the old contract may now be rejected. |
| breaking | GET | /users/{id} | operation.removed | Operation GET /users/{id} no longer exists in the new contract; requests to it may fail. |

## Usos afectados

| Ubicación | Operación | Confianza | Consecuencia | Revisión |
| --- | --- | --- | --- | --- |
| client.js:12:26 | POST /users | high | Potential break: New required property "displayName" for the request body \(application/json\) schema: requests valid under the old contract may now be rejected. | pending |
| client.js:12:26 | POST /users | high | Potential break: New required property "tenantId" for the request body \(application/json\) schema: requests valid under the old contract may now be rejected. | pending |
| client.js:30:26 | GET /preferences | low | Review needed: Composition keywords changed for the response 200 \(application/json\) schema \(oneOf\); compatibility is not provable and requires manual review. | pending |
| client.js:12:26 | POST /users | low | Review needed: Formerly required property "name" is no longer documented for the request body \(application/json\) schema; the specification does not prove whether the server ignores or rejects it. | pending |
| client.js:5:26 | GET /users/{id} | medium | Potential break: Operation GET /users/{id} no longer exists in the new contract; requests to it may fail. | pending |

## Reparaciones y verificación

Planes: 0. Comprobaciones: 0.


## Limitaciones

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

El resultado de pruebas locales no demuestra compatibilidad con producción.
