# Primera prueba con un usuario

Pide a un equipo que mantenga una integración JavaScript/TypeScript y disponga de dos OpenAPI (antes/después) que pruebe APIPatch en un repositorio local de trabajo. La herramienta no necesita GitHub ni subir código. Reserva unos 30–45 minutos; no prometas ahorro o precisión antes de medirlos.

1. Instala según [README](../README.md) y ejecuta `node dist/cli/main.js demo`. Comprueba que la salida distingue cambios reparados, ambiguos y niveles de verificación omitidos.
2. Ejecuta `compare` y `scan` sobre dos definiciones propias y una copia o rama del consumidor. Anota cuántas llamadas afectadas reconoce y cuántas no resuelve. Pide al usuario que señale falsos positivos y omisiones; no ajustes manualmente la métrica después de ver el resultado.
3. Elige un cambio con equivalencia confirmada por quien publica la API. Crea `migration.yaml` con IDs del informe y usa `repair` para generar `plan.json` y `repair.patch`. Revisa el diff línea por línea. Los casos de confianza baja o ambiguos deben quedarse pendientes.
4. Ejecuta `verify` y registra los cinco estados por separado. Si decides ejecutar pruebas del repositorio, autoriza expresamente ese comando en un entorno que controles. Aplica el plan únicamente a una copia/rama que hayas elegido. Comprueba los tests propios y, si existe, un sandbox de la API nueva; APIPatch no presupone acceso a producción.
5. Entrevista al usuario sobre claridad de hallazgos, justificaciones, pendientes y diff. Registra tiempo desde la comparación hasta un parche revisado, tiempo de corrección manual comparable, falsos positivos, cobertura de usos HTTP conocidos, parches aceptados/rechazados y razones. Guarda solo recuentos y observaciones consentidas; el código puede quedarse en su máquina.

Preguntas breves: «¿Cuál fue el último cambio de API que rompió tu integración?», «¿Cómo supiste qué llamadas revisar?», «¿Qué evidencia necesitarías para aceptar este cambio?», «¿Qué parte del informe es ambigua o incorrecta?». El [protocolo ampliado](PILOT.md) separa hipótesis comerciales de hechos observados.

Guion de demostración de 3 minutos: ejecuta `demo`; señala v1 verde, v2 con fallos concretos, los cinco hallazgos y el `oneOf` pendiente; muestra el diff y la copia reparada 3/3 en los casos soportados. Cierra con el informe de verificación, explicando por qué los niveles bloqueados u omitidos no son éxitos.
