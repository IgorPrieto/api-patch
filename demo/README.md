# Demo sintética (T5b)

```sh
npm run build && node dist/cli/main.js demo   # exit 0 only if every check passes
npx vitest run tests/integration/demo.test.ts
```

Flujo real, sin simulación: `loadApi(v1, v2)` → `compareApis` → `scanRepository(demo/repository)` → `loadMigration(demo/migration.yaml)` → `planRepairs` → `verifyRepairPlan` (sobre el original, sin escribir) → `applyRepairPlan` sobre una **copia temporal** → ejecución del consumidor contra una API sintética en `127.0.0.1:<puerto efímero>`.

| Fichero | Papel |
| --- | --- |
| `specs/v1.yaml`, `specs/v2.yaml` | Contratos. `servers: /` (misma origen). |
| `repository/client.js` | Consumidor real: `fetch` global con URLs relativas literales. |
| `migration.yaml` | Mapeos explícitos: ruta, query `locale→lang`, respuesta `fullName→displayName`, body `name→displayName`, valor `tenantId`. Sin mapeo para `/preferences`. |
| `harness/consumer-harness.mjs` | Ejecuta una exportación del consumidor en un proceso Node aparte (`--permission`, lectura solo del consumidor, sin escritura ni subprocesos, entorno vacío); resuelve URLs relativas contra la base loopback y rechaza otros orígenes. |

Resultado esperado: v1 4/4; v2 original falla `getUser HTTP 404` y `createUser HTTP 400 (missing displayName, tenantId)`; 5 hallazgos (3 resueltos, `oneOf` de `/preferences` y `schema.property.removed` de `name` pendientes); `/health` compatible, 0 hallazgos; copia reparada 3/3 casos soportados; `preferences` sigue fallando y se muestra como pendiente, nunca como verde.

## Interfaz para nivel 4 (verificador)

`src/demo/contract.ts`:

```ts
runConsumerContract({ repository, module, api: 'v1' | 'v2', cases?, timeoutMs?, signal? }): Promise<ContractRun>
// ContractRun = { api, module, cases: { id, exportName, property, supported, status: 'passed'|'failed'|'blocked', expected, actual, requests: RecordedRequest[] }[] }
DEMO_CASES  // casos de demo/repository/client.js
withDemoApi(version, run)  // src/demo/api.ts: API sintética efímera con registro de peticiones
```

`blocked` significa que no se ejecutó nada (error del arnés, tiempo agotado). Un resultado de nivel 4 solo debería declarar como comprobadas las `property` de los casos `passed`, y solo para esta API sintética.

## Límites

- La API sintética está escrita a mano a partir de las specs; no es un generador genérico de pruebas de contrato.
- Solo consumidores con URLs analizables (literales relativas o base constante). Una base dinámica queda `unresolved` y no se repara.
- En Node < 25 el modelo de permisos no restringe la red; solo el arnés limita `fetch` al origen loopback.
- `demo/consumer/client.mjs` es el consumidor anterior (base dinámica); lo usa `tests/unit/scan-matching.test.ts` y no participa en la demo.
