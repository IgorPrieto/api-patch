# APIPatch 0.1.0-beta.4

[English](RELEASE_NOTES.md) · [Español](RELEASE_NOTES.es.md)

Esta beta reduce tres limitaciones documentadas y es la primera versión preparada para el registro npm.

- **Comparación.** Las referencias recursivas de esquema se comparan estructuralmente con detección de ciclos, así que un cambio detrás de una referencia recursiva estable ya no pasa desapercibido; una referencia que no se puede resolver se marca ambigua. Las ramas de `allOf` con forma de objeto se combinan y se comparan con las reglas normales, y añadir o retirar ramas de `anyOf` se clasifica según la dirección. En OpenAPI 3.1 se conservan los hermanos de un `$ref` recursivo en lugar de descartarlos. Los cambios en `oneOf`, `not`, `if`/`then`/`else`, discriminator y `allOf` no combinable siguen siendo ambiguos.
- **Análisis del consumidor.** Las llamadas hechas a través de un wrapper del repositorio (mismo archivo o un import relativo, incluidas instancias `axios.create` importadas) se relacionan en cada punto de llamada, llevan una referencia `via` al wrapper y tienen como máximo confianza media. Un `let` de módulo nunca reasignado se resuelve como una constante. La llamada interna del wrapper conserva sus hallazgos salvo que se demuestre que todas sus llamadas están cubiertas.
- **Reparación.** Los renombres y valores de migración aceptan una ruta opcional `parent` para campos anidados de petición y respuesta. APIPatch edita objetos de petición anidados escritos en la llamada, cadenas de propiedades de respuesta (incluido el encadenamiento opcional y `response.data` de axios) y la desestructuración `const`/`let` de la respuesta. Las llamadas a través de wrappers se informan, pero nunca se editan.
- **Empaquetado.** `prepack` recompila `dist`; publicar una prerrelease exige `--tag beta`; tras la primera versión, un workflow de GitHub Actions publica con procedencia de npm. Consulta [RELEASING.es.md](RELEASING.es.md).

Instalación con Node.js 24 o superior:

```sh
npm install -g apipatch@beta
apipatch demo --verify-level4
```

También sirve el tarball adjunto a la [release de GitHub](https://github.com/IgorPrieto/api-patch/releases/tag/v0.1.0-beta.4): `npm install -g ./apipatch-0.1.0-beta.4.tgz`.

Los archivos de migración de la beta.3 siguen siendo válidos (`schemaVersion` "1.0"; los campos nuevos son opcionales). Los informes pueden incluir el nuevo campo opcional `via` en los usos, y los esquemas de destino de recursión llevan la anotación `x-apipatch-recursion-anchor`.

Limitaciones: los cambios de autenticación no se reparan; nunca se deducen renombres semánticos; los wrappers fuera de la forma de llamada única, las cadenas de wrappers y las reexportaciones requieren revisión; no se reparan campos anidados a través de arrays, `oneOf`/`anyOf` o esquemas recursivos; la comparación de JSON Schema sigue siendo parcial; el nivel 4 de verificación de contrato solo cubre la demo sintética. Superar comprobaciones locales no garantiza la compatibilidad en producción. Consulta la [matriz de compatibilidad](COMPATIBILITY.md) y la [validación observada](VALIDATION.md).

Anterior: la 0.1.0-beta.3 añadió la documentación, la CLI y el panel en inglés, manteniendo el español como opción.
