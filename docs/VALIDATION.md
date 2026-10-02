# Validación observada de la beta 0.1.0-beta.2

Fecha: 2026-10-02. Entorno local Linux x64. Estas pruebas verifican la distribución y la demo sintética; no demuestran compatibilidad con una API de producción ni adopción por usuarios reales.

| Comprobación | Resultado observado |
| --- | --- |
| Instalación de dependencias | `npm ci` terminó con código 0; 41 paquetes instalados y 0 vulnerabilidades notificadas por npm en esta ejecución. |
| Node 24.21.0 | `npm run check` terminó con código 0: 15 archivos de pruebas, 177/177 pruebas aprobadas. Se usó el binario Node 24.21.0 para ejecutar los scripts. |
| Node 26.5.0 | `npm run check` terminó con código 0: 15 archivos de pruebas, 177/177 pruebas aprobadas. |
| Tarball | `npm pack` generó `apipatch-0.1.0-beta.2.tgz`; 113 archivos, sin documentos internos de orquestación. Instalación en directorio limpio: 5 paquetes de ejecución y código 0. |
| CLI instalada con Node 24 | `apipatch --version` mostró `0.1.0-beta.2`; `apipatch --help` mostró los siete comandos; `apipatch demo --verify-level4` terminó con código 0. Consumidor v1 4/4, consumidor antiguo contra v2 falló en GET/POST, copia reparada 3/3 casos soportados; dos hallazgos ambiguos quedaron pendientes. |

La configuración de npm de este entorno rechaza instalar directamente una URL remota con `EALLOWREMOTE`. La ruta documentada descarga el tarball con `curl` y lo instala como archivo local; se comprobó la suma SHA-256 y el funcionamiento del paquete descargado. Esto no requiere una cuenta npm.

El nivel 4 solo prueba el contrato sintético empaquetado. En el ejemplo de verificación aislada, el nivel 3 está bloqueado por errores previos del fixture y el nivel 5 omitido; ver [verification.json](../examples/demo/verification.json). El recorrido e2e del panel usa Chromium cuando está disponible; las pruebas pueden omitirse en un entorno sin navegador y el resultado debe declararse como tal. La [matriz de compatibilidad](COMPATIBILITY.md) enumera otros límites.
