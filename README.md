# APIPatch

APIPatch compara dos definiciones OpenAPI, busca llamadas afectadas en un repositorio JavaScript/TypeScript y prepara cambios de código revisables. Funciona localmente, sin cuenta, inferencia ni servicio de pago. Un parche necesita correspondencias confirmadas en un archivo de migración; los casos inciertos quedan pendientes. Esta es una primera versión de alcance deliberadamente acotado.

**Beta pública 0.1.0-beta.2.** Para probarla sin clonar el código, descarga el paquete de la [GitHub Release](https://github.com/IgorPrieto/api-patch/releases/tag/v0.1.0-beta.2) e instálalo con Node.js 24 o superior:

```sh
curl -fL -o apipatch-0.1.0-beta.2.tgz https://github.com/IgorPrieto/api-patch/releases/download/v0.1.0-beta.2/apipatch-0.1.0-beta.2.tgz
npm install -g ./apipatch-0.1.0-beta.2.tgz
apipatch demo --verify-level4
```

La release incluye `SHA256SUMS.txt` para comprobar la descarga. También puedes instalar desde el código fuente con los pasos siguientes. La beta aún no está publicada en el registro npm. La [guía de prueba pública](docs/PUBLIC_BETA.md) explica cómo evaluar un repositorio propio y [enviar resultados](https://github.com/IgorPrieto/api-patch/issues/new/choose) sin compartir código privado. No se envía telemetría ni código a un servidor de APIPatch.

## Instalación

Requiere Node.js 24 o superior y npm. Desde esta carpeta:

```sh
npm ci
npm run build
node dist/cli/main.js --help
```

`npm ci` usa el lockfile; no se necesita un compilador global. Para usar el binario como paquete local: `npm pack`, instalar el `.tgz` en otro proyecto con npm y ejecutar `npx apipatch --help`. La comprobación de ese empaquetado en un directorio limpio figura en [validación de la beta](docs/VALIDATION.md).

Si instalaste el tarball global de la release, sustituye `node dist/cli/main.js` por `apipatch` en los ejemplos siguientes.

## Demo reproducible

```sh
node dist/cli/main.js demo
```

Los datos son **sintéticos**. El comando levanta APIs v1/v2 en un puerto efímero de loopback, ejecuta el consumidor del proyecto, compara/analiza, planea una migración explícita y aplica el parche **solo a una copia temporal**. Muestra las fallas concretas del consumidor antiguo contra v2, los cambios que sí repara y los pendientes. Usa el harness propio de APIPatch y no requiere credenciales. `demo --verify-level4` activa además el nivel 4 del verificador para este único fixture controlado. La explicación de los casos y el archivo de migración están en [demo/README.md](demo/README.md).

## Análisis de un repositorio local

```sh
node dist/cli/main.js compare --old api-v1.yaml --new api-v2.yaml --json
node dist/cli/main.js scan --old api-v1.yaml --new api-v2.yaml --repo ./mi-app --base-url https://api.example.test --out ./apipatch-output/report.json
node dist/cli/main.js report --input ./apipatch-output/report.json --format markdown --out ./apipatch-output/report.md
```

`--base-url` sirve para URL relativas cuyo origen conozcas. `compare` y `scan` aceptan `--fail-on breaking` (código 2 si hay incompatibilidades) o `--fail-on ambiguous` (código 2 si hay cambios incompatibles o ambiguos). Sin ese umbral devuelven código 0 para un análisis válido aunque haya cambios. Los errores de entrada usan código 1.

El análisis solo lee el código del repositorio; no lo importa, compila ni ejecuta scripts. Las rutas y métodos que no se resuelven de forma fiable se muestran con confianza baja o quedan sin asociación. Consulta la [matriz de compatibilidad](docs/COMPATIBILITY.md) antes de interpretar los resultados.

## Vista previa, verificación y aplicación

Prepara un [archivo de migración](docs/MIGRATION.md) con IDs del informe y decisiones confirmadas:

```sh
node dist/cli/main.js repair --report ./apipatch-output/report.json --migration ./migration.yaml --repo ./mi-app --out ./apipatch-output
node dist/cli/main.js verify --plan ./apipatch-output/plan.json --repo ./mi-app --json
```

`repair` crea `plan.json` y `repair.patch`, sin tocar el repositorio. Revisa el diff y los pendientes antes de solicitar una aplicación:

```sh
node dist/cli/main.js repair --apply ./apipatch-output/plan.json --repo ./mi-app
```

La aplicación comprueba que cada archivo conserve el hash analizado, rechaza rutas inseguras y no reescribe un archivo cambiado. Si tiene éxito, guarda `plan.applied.json` junto al plan original (o en `--applied-out`). Para autorizar **un comando concreto** después de aplicar, ejecuta, por ejemplo:

```sh
node dist/cli/main.js verify --plan ./apipatch-output/plan.applied.json --repo ./mi-app --allow-repo-command --command npm --arg=test
```

Esa opción ejecuta `npm test` dentro de `./mi-app`; úsala solo si conoces sus scripts. No hay shell implícito. `verify` indica cada nivel por separado: validez del plan, sintaxis, tipos cuando son comprobables, contrato controlado y prueba del repositorio autorizada. `skipped` y `blocked` no equivalen a aprobado. Devuelve código 4 si falla un nivel y código 5 si queda bloqueado. `verify --demo-contract` solo acepta un plan derivado de la demo empaquetada; otro consumidor queda bloqueado sin ejecutarse. Analizar o verificar sin `--allow-repo-command` no ejecuta scripts del repositorio.

## Panel local

```sh
node dist/cli/main.js ui --workspace . --port 0
```

El servidor imprime una dirección de localhost con un token de sesión en el fragmento; ábrela en el navegador. Las rutas quedan restringidas al workspace indicado. Permite revisar el análisis, el diff y la verificación, exportar artefactos y aplicar un plan solo con confirmación explícita. Sus controles y pruebas se registran en [validación de la beta](docs/VALIDATION.md).

## Primer usuario

Empieza con la demo; después usa dos OpenAPI reales y un repositorio local de prueba. Conserva la salida de `scan`, revisa cada hallazgo con confianza y pregunta al dueño de la API por renombres/valores antes de completar la migración. Genera el parche, ejecútalo contra una copia o una rama de trabajo y revisa las comprobaciones. No interpretes una prueba local como garantía de producción. La [guía de primer piloto](docs/FIRST_USER.md) propone una sesión de prueba y qué datos recoger sin enviar código a terceros.

Documentos: [arquitectura](docs/ARCHITECTURE.md), [reglas de comparación](src/compare/RULES.md), [reparaciones y límites](src/repair/REPAIRS.md), [matriz](docs/COMPATIBILITY.md), [migración](docs/MIGRATION.md), [pilotos y métricas](docs/PILOT.md), [licencia](LICENSE) y [dependencias relevantes](THIRD_PARTY_NOTICES.md). Se incluyen [informes y parche de ejemplo](examples/demo/README.md). Hay un [caso público reconstruido](examples/public-case/README.md) con procedencia citada; sus documentos y consumidor son sintéticos, no una prueba de un repositorio real de GitHub.
