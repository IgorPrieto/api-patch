# Arquitectura de APIPatch

[English](ARCHITECTURE.en.md) · [Español](ARCHITECTURE.md)

APIPatch es un paquete npm local. CLI y servidor llaman a módulos del mismo proceso; los informes JSON permiten separar análisis, revisión y aplicación. El panel no ejecuta código arbitrario del repositorio. El núcleo funciona sin modelos, cuentas o infraestructura externa.

```text
OpenAPI v1/v2 → openapi → compare ──────────┐
                                            ├→ scan → informe
Repositorio JS/TS ──────────────────────────┘             │
                                       migración confirmada → repair → plan/diff
                                                                │
                                                       verify / apply explícito
                                                                │
                                                       CLI y servidor local
```

Los contratos en `src/contracts` separan hechos observados (`ApiChange`, `ConsumerUse`, `Finding`) de decisiones (`MigrationConfig`) y de acciones (`RepairPlan`). `schemaVersion` identifica el formato persistido. IDs y hashes hacen reproducible la relación entre archivos, análisis y parche. La validación estructural no demuestra que un plan siga siendo aplicable: los servicios revisan los archivos y sus hashes de nuevo.

`src/openapi` carga documentos y resuelve únicamente referencias locales dentro de una raíz permitida. `src/compare` clasifica cambios direccionales. `src/scan` usa el AST de TypeScript para asociar operaciones HTTP al consumidor, con confianza y motivos. `src/repair` prepara ediciones verificables con mapeos explícitos. `src/verify` comprueba niveles de validez, sintaxis, tipos y pruebas según lo realmente ejecutado. `src/report` produce JSON y Markdown; `src/cli` y `src/server` exponen estos servicios.

El análisis no importa módulos JS/TS ni ejecuta scripts. Las llamadas con URL, método o transformación irresoluble aparecen como revisión manual. Los informes exportados omiten expresiones URL y valores capturados que podrían contener credenciales; conservan archivo, rango, método, operación, evidencia y confianza. La vista previa y el diff no mutan el consumidor. La aplicación explícita comprueba rutas, symlinks, hashes y conflictos justo antes de escribir. Una propuesta puede superar comprobaciones sobre una copia sin estar aplicada al repositorio; estar aplicada no significa estar verificada.

Cada `VerificationResult` indica nivel, estado, propiedades comprobadas, evidencia y razón de omisión o bloqueo. El nivel 4 solo ejecuta el contrato sintético empaquetado mediante opt-in y comprueba que el plan provenga de ese fixture; la prueba no demuestra compatibilidad en producción. El nivel 5 de scripts del repositorio requiere una autorización separada con comando, argumentos y directorio concretos. La CLI devuelve 4 ante fallos y 5 ante estados bloqueados.

El servidor escucha solo en `127.0.0.1`, restringe archivos al workspace seleccionado por la CLI y pide un token de sesión en sus rutas API. Rechaza Host/Origin ajenos, limita cuerpos y rutas, y no ofrece ejecución de comandos. La UI expone artefactos solo de la sesión local. La matriz de compatibilidad describe patrones exactos que el producto entiende y los casos manuales.

Los estados y resultados reales están en [VALIDATION.md](VALIDATION.md) y [ACCEPTANCE.md](ACCEPTANCE.md).
