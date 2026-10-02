# Archivo de migración

El archivo JSON o YAML registra decisiones confirmadas. La forma inicial tiene `schemaVersion: "1.0"` y cuatro listas obligatorias. La CLI valida la estructura, versiones y duplicados antes de planear reparaciones; el reparador debe verificar además que los destinos existen en la API nueva y que hay un uso de código editable.

```yaml
schemaVersion: "1.0"
allowedOrigins:
  - http://127.0.0.1:4010
operations:
  - from: "operation_<ID_DE_V1>"
    to: "operation_<ID_DE_V2>"
renames:
  - operationId: "operation_<ID_POST_USERS_DE_V2>"
    location: request
    from: name
    to: displayName
  - operationId: "operation_<ID_DE_V2>"
    location: query
    from: locale
    to: lang
  - operationId: "operation_<ID_DE_V2>"
    location: response
    from: fullName
    to: displayName
values:
  - operationId: "operation_<ID_POST_USERS_DE_V2>"
    location: request
    name: tenantId
    value: demo-tenant
```

Los identificadores con `<...>` son marcadores: se sustituyen por los IDs de operación reales del informe de análisis. `operations.from` usa un ID de la API antigua, `operations.to` uno de la nueva. `renames.operationId` y `values.operationId` usan el ID de la operación destino en la API nueva; cuando la operación no cambia de ruta/método, ambos IDs son iguales. El cargador usa IDs estables con prefijo `operation_`. `allowedOrigins` contiene orígenes HTTP(S) exactos, sin ruta ni credenciales. Un origen listado limita dónde pueden aplicarse estos mapeos: no declara que la API de producción esté verificada.

Una correspondencia de operación autoriza cambiar la ruta solamente en un uso inequívoco. `renames` autoriza renombrar una clave de query o de objeto de petición, o un acceso directo a propiedad de respuesta, si el AST identifica su rango sin ambigüedad. `values` incluye un valor obligatorio expresamente indicado por el usuario. Los nombres parecidos no generan correspondencias automáticas.

Ejemplo rechazado: dos entradas `operations` con el mismo `from`, una propiedad no reconocida o `allowedOrigins: ["https://api.example.com/path"]`. Un archivo válido puede producir pendientes si el consumidor construye la URL dinámicamente, transforma una respuesta mediante un wrapper o no hay binding exacto.

El ejemplo anterior usa datos sintéticos de la demo. El archivo ejecutable [`demo/migration.yaml`](../demo/migration.yaml), los [artefactos exportados](../examples/demo/README.md) y la prueba de extremo a extremo muestran la forma exacta y las reparaciones admitidas.
