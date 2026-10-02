# Publicar APIPatch en npm

[English](RELEASING.md) · [Español](RELEASING.es.md)

APIPatch se publica como el paquete sin ámbito `apipatch`. Las prerreleases (`0.1.0-beta.N`) usan la etiqueta `beta`; solo las versiones estables usan `latest`. `npm publish` rechaza una prerrelease sin `--tag beta` (`scripts/check-dist-tag.mjs`, ejecutado por `prepublishOnly`), porque npm ignora `publishConfig.tag`. `prepack` recompila `dist` para que el tarball nunca lleve una compilación antigua.

## Lista de comprobación en cada versión

1. Coinciden la versión de `package.json`, `docs/RELEASE_NOTES*.md` y las líneas de instalación del README.
2. `npm ci && npm run check` pasa en local y en CI (Node 24 y 26, incluidas las pruebas e2e del panel).
3. `npm pack`, instalar el tarball en un directorio vacío y ejecutar `npx apipatch --version` y `npx apipatch demo --verify-level4`.
4. `npm publish --dry-run --tag beta` muestra la lista de archivos esperada (unos 130, menos de 300 kB comprimido) y la etiqueta `beta`.

## Primera publicación (manual, una sola vez)

La publicación de confianza (trusted publishing) solo se puede configurar en un paquete que ya existe en npm, así que la primera versión la publica una persona mantenedora:

    npm login                      # cuenta con 2FA activado
    git checkout v0.1.0-beta.4 && npm ci && npm run check
    npm publish --tag beta --access public

Después, en npmjs.com → paquete `apipatch` → Settings → Trusted publishing, añade GitHub Actions con el repositorio `IgorPrieto/api-patch`, el workflow `publish.yml` y el entorno `npm`. Crea el entorno `npm` en la configuración del repositorio de GitHub (opcionalmente con revisores obligatorios). Luego exige 2FA y deshabilita los tokens en el acceso de publicación del paquete.

## Versiones posteriores (automatizadas)

Publicar una release de GitHub con etiqueta `v<versión de package.json>` ejecuta `.github/workflows/publish.yml`: `npm ci`, `npm run check`, comprobación de etiqueta/versión y `npm publish --provenance` con `beta` para prerreleases o `latest` en otro caso. Una ejecución manual (`workflow_dispatch`) es un ensayo salvo que se desmarque `dry_run`. `NPM_TOKEN` solo es una alternativa si no se configura trusted publishing.

No publiques nunca desde un árbol con cambios sin confirmar. Para retirar una versión defectuosa dentro de 72 horas usa `npm unpublish apipatch@<versión>`; después, `npm deprecate`.
