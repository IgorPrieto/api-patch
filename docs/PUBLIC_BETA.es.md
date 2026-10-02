# Beta pública: prueba APIPatch con un cambio real

[English](PUBLIC_BETA.md) · [Español](PUBLIC_BETA.es.md)

APIPatch 0.1.0-beta.4 funciona en tu equipo. Buscamos comprobar si identifica usos afectados y produce reparaciones que un mantenedor aceptaría. No hay telemetría automática, cuenta ni envío de código a APIPatch.

## Prueba de 15–30 minutos

1. Instala la beta desde la [release](https://github.com/IgorPrieto/api-patch/releases/tag/v0.1.0-beta.4) siguiendo el [README](../README.es.md). Ejecuta `apipatch --lang es demo --verify-level4` para conocer qué significa cada estado.
2. Elige dos versiones OpenAPI 3.0/3.1 y una **copia o rama** de un consumidor JavaScript/TypeScript que use `fetch` o `axios`. Ejecuta `compare` y `scan` según el README; el análisis no ejecuta el repositorio.
3. Revisa los hallazgos de confianza alta y los pendientes. Para cada cambio real, anota si APIPatch encontró todas las llamadas afectadas, inventó alguna o dejó sin resolver un patrón que esperabas que cubriera.
4. Si conoces una equivalencia de migración, configúrala y genera la vista previa con `repair`. Revisa el diff. Aplica solo en la copia o rama que controlas y ejecuta pruebas del repositorio únicamente si lo autorizas expresamente.
5. Cuéntanos si el parche fue aceptado tal cual, editado, rechazado o quedó pendiente. Una prueba sintética o un nivel omitido no demuestra compatibilidad en producción.

## Cómo enviar resultados

Usa los [formularios de issues](https://github.com/IgorPrieto/api-patch/issues/new/choose): fallo de uso, llamada afectada no detectada o evaluación de un parche. Indica versión de Node, sistema operativo, versión de APIPatch, patrón de llamada y resultado esperado/observado. Comparte un ejemplo **mínimo y sintético** si hace falta reproducirlo. No adjuntes especificaciones privadas, secretos, URLs con credenciales ni extractos de código cuyo propietario no autorice la publicación.

Si prefieres medirlo sin publicar tu código, envía solo recuentos: llamadas afectadas revisadas, verdaderos positivos, falsos positivos, omisiones y parches aceptados/editados/rechazados. Etiqueta las cifras como observadas o estimadas. No inferiremos precisión a partir de descargas.

La [matriz de compatibilidad](COMPATIBILITY.md) define el alcance: una URL dinámica, un wrapper propio, un cambio de autenticación o un campo anidado pueden requerir revisión manual. Para fallos de seguridad usa [divulgación privada](../SECURITY.es.md), nunca un issue público con detalles explotables.
