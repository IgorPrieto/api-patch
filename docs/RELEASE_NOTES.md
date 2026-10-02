# APIPatch 0.1.0-beta.1

Primera beta pública de la CLI y el panel local. Compara OpenAPI 3.0/3.1 JSON/YAML, relaciona cambios con llamadas `fetch`/`axios` en JS/TS, genera parches a partir de mapeos explícitos y distingue propuesta, aplicación y niveles de verificación. Incluye una demo sintética antes/después y exportes JSON, Markdown y patch.

Instalación desde el tarball adjunto a esta release:

```sh
npm install -g https://github.com/IgorPrieto/api-patch/releases/download/v0.1.0-beta.1/apipatch-0.1.0-beta.1.tgz
apipatch demo --verify-level4
```

Requiere Node.js 24 o superior. El paquete todavía no está publicado en el registro npm. Consulta la [guía de prueba](PUBLIC_BETA.md), la [matriz de compatibilidad](COMPATIBILITY.md) y la [validación observada](VALIDATION.md). No se envía código ni telemetría a APIPatch. Para probar un repositorio propio, usa una copia o rama y envía feedback con un ejemplo sintético.

Limitaciones principales: URLs y wrappers dinámicos requieren revisión; no se deducen renombres semánticos; los cambios de autenticación no se reparan automáticamente; la comparación de JSON Schema es parcial; el nivel 4 de contrato solo cubre la demo; superar pruebas locales no garantiza producción. Los dos hallazgos ambiguos de la demo permanecen pendientes.
