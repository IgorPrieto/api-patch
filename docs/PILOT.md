# Primer usuario, entrevistas y piloto

## Cliente e hipótesis

El primer perfil a entrevistar es una persona responsable de integraciones JavaScript/TypeScript que consume APIs documentadas con OpenAPI y mantiene varios puntos de llamada. El problema propuesto: un cambio de contrato obliga a descubrir usos, decidir migraciones y reunir pruebas de que el parche es seguro. Esto es una hipótesis de necesidad, todavía sin validación con usuarios.

Hipótesis de diferenciación, no resultados comprobados de mercado:

- Vincular cada diferencia del contrato a ubicaciones AST concretas del consumidor, con evidencia y confianza.
- Exigir decisiones de migración explícitas para cambios semánticos y mantener lo ambiguo en revisión.
- Producir diff e informe locales con niveles de verificación reproducibles, sin exigir un remoto o un modelo.

La comparación competitiva debe realizarse después con flujos reales de las herramientas que los entrevistados usan. No asumir que esas capacidades son únicas ni que alguien pagará por ellas.

## Entrevista de descubrimiento (25 minutos)

1. Pedir el relato del último cambio incompatible de una API consumida: cuándo lo descubrieron, señal inicial y consecuencia.
2. Pedir que recorran cómo encontraron todos los usos, quién decidió la migración y qué archivos cambiaron. Registrar el tiempo activo y esperas por separado.
3. Preguntar qué evidencias exigieron para revisar y aprobar el parche; qué pruebas faltaban y qué quedó manual.
4. Preguntar qué herramientas usaron y dónde aparecieron falsos positivos o cambios pasados por alto.
5. Mostrar APIPatch al final, pedir que identifiquen una integración candidata para piloto y motivos por los que no confiarían en el resultado.

No pedir secretos ni copiar repositorios de producción. Registrar las respuestas con permiso y separar citas de interpretación.

## Piloto local

Definir antes del piloto: versiones OpenAPI, una copia del consumidor JS/TS, bases conocidas, directorios excluidos y permiso específico para cualquier comando de pruebas. Guardar un identificador local del caso, sin publicar código. Hacer primero una línea base del proceso manual sobre un cambio comparable; después ejecutar análisis, revisar hallazgos y clasificar cada uno como correcto, falso positivo o no evaluable.

Revisar cada propuesta: aceptada sin cambios, aceptada con edición, rechazada o pendiente. Medir tiempo activo de análisis y parche manual frente al flujo asistido, con la misma definición de inicio y fin. Indicar tamaño de muestra y complejidad; una demo sintética no cuenta como piloto.

## Métricas a recoger

| Métrica | Numerador / denominador o definición | Qué evita confundir |
| --- | --- | --- |
| Tiempo ahorrado | Minutos activos de línea base menos minutos activos con APIPatch para tareas comparables | Esperas externas y diferencias de alcance |
| Falsos positivos | Hallazgos adjudicados incorrectos / hallazgos adjudicados | Hallazgos no revisados no se cuentan como correctos |
| Cobertura | Usos afectados detectados / usos afectados identificados por revisión independiente | Cambios de especificación sin consumidor no son usos |
| Parches aceptados | Parches aceptados sin cambios / parches revisados; registrar editados por separado | Una aplicación automática no implica aceptación |

Registrar también casos omitidos por patrón no soportado, duración de checks y razones de rechazo. No hay métricas comerciales ni entrevistas realizadas al crear este documento.

## Guion de demostración

Con la demo sintética: v1 responde correctamente; v2 produce fallos específicos; ejecutar análisis y abrir archivo/ubicación afectada; inspeccionar regla, confianza y evidencia; mostrar el archivo de migración y el diff; aplicar en copia; repetir comprobaciones y mostrar cuáles pasaron y cuáles quedaron omitidas. Cerrar con el caso ambiguo pendiente y el cambio compatible sin alarma. Exportar el informe para revisión independiente.
