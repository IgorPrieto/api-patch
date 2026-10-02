# Aceptación de la primera versión — 2026-10-01

Estado: **AC1–AC12 cumplidos dentro de la matriz declarada** para la versión 0.1. La prueba sintética y los checks locales no demuestran compatibilidad en producción ni validación comercial. Los comandos y resultados de la beta están en [VALIDATION.md](VALIDATION.md).

| Criterio | Evidencia observada |
| --- | --- |
| AC1 instalación | `npm ci` y `npm run check` pasaron; `npm pack` e instalación del tarball en un directorio limpio pasaron; el binario instalado mostró ayuda, ejecutó demo y arrancó `ui` (HTML/API 200). Node 26.5.0 comprobado; ver [validación](VALIDATION.md) para la beta. |
| AC2 OpenAPI | Pruebas 3.0/3.1 JSON/YAML, referencias locales, dialectos y documentos inválidos. Tras la corrección 3.1, 39/39 pruebas OpenAPI+compare afectadas pasaron. Webhooks se cargan con diagnóstico de no comparación. |
| AC3 CLI/UI reales | CLI `compare`, `scan`, `repair`, `verify`, `report`, `demo`, `ui`; servidor del paquete instalado hizo análisis real de 5 hallazgos y exportó patch; e2e en Chromium 152: 2/2 pruebas. |
| AC4 antes/después | `apipatch demo --verify-level4` exit 0: v1 consumidor 4/4; v2 original GET 404 y POST 400; copia temporal reparada 3/3 casos soportados, 10/10 checks de demo. |
| AC5 incertidumbre | Dos hallazgos ambiguos de la demo permanecen pendientes; `/health` compatible funciona antes/después sin hallazgo falso. Uso con base opaca queda de confianza baja y no se parchea. |
| AC6 parche justificado | `demo/migration.yaml`, [plan](../examples/demo/plan.json) y [diff](../examples/demo/repair.patch); hashes, conflictos y re-aplicación probados; aplicación al original solo por opción/confirmación explícita. |
| AC7 verificación por niveles | [verification.json](../examples/demo/verification.json): niveles 1 y 2 `passed`, 3 `blocked` por errores previos, 4 `passed` solo para 3 casos sintéticos soportados, 5 `skipped` sin autorización. CLI exit 5 ante bloqueo. |
| AC8 sin dependencias de pago ni ejecución oculta | Instalación local con dependencias abiertas; ninguna API de modelo. Escanear o verificar por defecto no ejecuta scripts del consumidor; la demo usa fixture propio y loopback. Nivel 5 requiere `--allow-repo-command --command` y plan aplicado. |
| AC9 exportes | [analysis.json](../examples/demo/analysis.json), [report.md](../examples/demo/report.md), [repair.patch](../examples/demo/repair.patch) generados por CLI. Los informes omiten URL literal y valores capturados del código. |
| AC10 servidor acotado | 41/41 tests de servidor+e2e afectados: Host/Origin/token, ruta/symlink/tamaño, revisión, exportes, aplicación con hash, rechazo de credenciales en URL base. Servidor en `127.0.0.1`. |
| AC11 pruebas/UX | `npm run check` tras `npm ci`: 15 archivos de pruebas, 177/177 tests. El e2e de Chromium recorrió teclado, selector, análisis, errores, diff, verificación, descarga y aplicación explícita. |
| AC12 documentación | [README](../README.md), [arquitectura](ARCHITECTURE.md), [matriz](COMPATIBILITY.md), [migración](MIGRATION.md), [licencia](../LICENSE), [dependencias](../THIRD_PARTY_NOTICES.md), [primer usuario](FIRST_USER.md), [piloto](PILOT.md) y caso público reconstruido con procedencia. |

Límites materiales: comparación de JSON Schema parcial y referencias recursivas por texto; webhooks 3.1 no comparados; cambios de seguridad requieren intervención; los patrones JS/TS no resueltos no se reparan; nivel 4 solo cubre la demo sintética empaquetada; la prueba de tipos aislada puede quedar bloqueada por errores existentes; la aplicación multiarchivo tiene atomicidad por archivo con rollback best-effort; no se ha probado una API de producción ni un usuario real. La [matriz](COMPATIBILITY.md) detalla cada caso.
