# Contribuir a APIPatch

[English](CONTRIBUTING.md) · [Español](CONTRIBUTING.es.md)

Prueba primero la [beta pública](docs/PUBLIC_BETA.es.md) y consulta la [matriz](docs/COMPATIBILITY.md). Un hallazgo pendiente dentro de la matriz no debe presentarse como reparación automática.

Para desarrollar: Node.js 24 o superior, `npm ci`, `npm run check` y `node dist/cli/main.js demo --verify-level4`. Si tienes Chrome o Chromium, la suite incluye el recorrido e2e del panel; si no, ese caso se omite y debes indicarlo al informar tus resultados.

Abre un issue con una reproducción mínima y sintética antes de proponer un cambio amplio. Los PR deben explicar el patrón soportado, la evidencia AST/OpenAPI que justifica la clasificación, los casos que quedan sin resolver y las pruebas ejecutadas. No incluyas credenciales, código privado ni informes de clientes sin autorización. Para vulnerabilidades sigue [SECURITY.es.md](SECURITY.es.md).

El código se distribuye bajo [MIT](LICENSE). Al contribuir aceptas que tu contribución se distribuya bajo esa licencia.
