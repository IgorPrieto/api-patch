# Caso basado en un cambio documentado de GitHub

GitHub [anunció el 10 de diciembre de 2024](https://github.blog/changelog/2024-12-10-notice-of-breaking-changes-security-manager-rest-api-will-be-retired-and-replaced-with-the-organization-roles-rest-api/) la retirada de tres endpoints de security managers, incluido `GET /orgs/{org}/security-managers/teams`, con fecha anunciada para GitHub.com de 31 de diciembre de 2025. La misma nota enumera `GET /orgs/{org}/roles/{role_id}/teams` entre los endpoints de la API de roles para migrar.

`old.yaml` y `new.yaml` son **reconstrucciones mínimas nuestras**, no versiones publicadas del OpenAPI de GitHub. Incluyen solo rutas y parámetros necesarios para demostrar detección de un endpoint retirado. `consumer.js` también es sintético y no debe ejecutarse contra GitHub. No inferimos que reemplazar la ruta conserve semántica: la ruta nueva exige un `role_id` cuya obtención depende del flujo del usuario. Por eso este caso debe quedar para revisión manual y no producir un parche automático sin un mapeo y valor confirmados.

Después de instalar APIPatch, ejecutar desde la raíz del paquete:

```bash
apipatch compare --old examples/public-case/old.yaml --new examples/public-case/new.yaml
apipatch scan --old examples/public-case/old.yaml --new examples/public-case/new.yaml --repo examples/public-case
```

Comprobación local del 2026-10-01: la comparación emitió dos cambios (una operación añadida compatible y una retirada incompatible). El análisis encontró un uso HTTP y un hallazgo asociado a la operación retirada. Se exportaron [analysis.json](analysis.json) y [report.md](report.md) con esos resultados. La ruta de roles nueva queda para revisión manual porque requiere decidir `role_id` y comprobar su semántica.

Las rutas absolutas de esos artefactos se normalizaron a `./` para publicarlos; vuelve a ejecutar el análisis para obtener rutas del checkout actual.

El caso prueba análisis estático local de un cambio documentado; no prueba el estado actual ni la respuesta de la API de GitHub en producción.
