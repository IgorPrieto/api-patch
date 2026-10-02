# Artefactos de la demo sintética

[English](README.en.md) · [Español](README.md)

Estos archivos se generaron con la CLI sobre `demo/specs/v1.yaml`, `demo/specs/v2.yaml` y `demo/repository` el 2026-10-01. Son **sintéticos** y conservan resultados reales de ejecución local, no métricas de clientes.
Las rutas absolutas de los artefactos se normalizaron a `./` para publicarlos. Estos archivos muestran una ejecución observada, pero el plan de ejemplo no es portable ni debe aplicarse tal cual en otro checkout: vuelve a ejecutar los comandos para generar hashes y rutas actuales.

- [analysis.json](analysis.json): 8 cambios, 4 usos HTTP y 5 hallazgos; dos ambiguos pendientes.
- [report.md](report.md): informe legible. El JSON exportado oculta expresiones URL y valores capturados; archivo y rango permanecen.
- [plan.json](plan.json) y [repair.patch](repair.patch): propuesta de cuatro ediciones en `client.js`, sin aplicar al archivo original.
- [verification.json](verification.json): niveles 1/2 aprobados, 3 bloqueado por errores previos del fixture, 4 aprobado para 3/3 casos soportados de la API sintética, 5 omitido por falta de autorización de comando. La CLI terminó con código 5 por el nivel bloqueado.

Reproducir desde la raíz del paquete después de `npm ci && npm run build`:

```sh
node dist/cli/main.js demo --verify-level4
node dist/cli/main.js scan --old demo/specs/v1.yaml --new demo/specs/v2.yaml --repo demo/repository --out examples/demo/analysis.json
node dist/cli/main.js repair --report examples/demo/analysis.json --migration demo/migration.yaml --repo demo/repository --out examples/demo
node dist/cli/main.js verify --plan examples/demo/plan.json --repo demo/repository --demo-contract --out examples/demo/verification.json
```

El comando `verify` devuelve 5 aquí porque el chequeo aislado de tipos queda bloqueado; el nivel 4 aprobado no lo convierte en una verificación total ni en garantía de producción.
