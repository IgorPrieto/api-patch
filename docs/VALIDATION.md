# Observed validation — APIPatch 0.1.0-beta.4

Date: 2026-10-02. Local Linux x64 checks. They validate packaging and the synthetic demo, not production compatibility or adoption by real users.

| Check | Observed result |
| --- | --- |
| Dependency installation | `npm ci` exited 0; 41 packages installed. |
| Node 24.21.0 | `npm run check` exited 0: 18 test files, 237/237 tests passed. |
| Node 26.5.0 | `npm run check` exited 0: 18 test files, 237/237 tests passed. |
| Browser panel | With `APIPATCH_CHROME=/usr/bin/chromium` the real Chromium end-to-end suite ran (3/3): token refusal, English analysis/export, and the Spanish selection → analysis → findings → diff → verification → export → apply path. |
| New analysis cases | Unit fixtures cover recursive and mutually recursive schemas, `allOf` merging, `anyOf` branches, repository-local wrappers (same file, one import hop, imported `axios.create`), never-reassigned `let`, nested request/response repairs and response destructuring. A manual CLI run on a synthetic consumer reported a wrapper call with `via` and medium confidence, left it pending in `repair`, and repaired the equivalent direct call. |
| Package contents | `npm pack` produced 131 files, 328.6 kB packed (1.4 MB unpacked): CLI build, panel assets, English/Spanish docs, demo and example reports. `npm publish --dry-run --tag beta` targeted the `beta` dist-tag; without `--tag` the prerelease guard refused to publish. |
| Clean install | The generated `0.1.0-beta.4` tarball installed with Node 24.21.0 in a separate empty directory with five runtime packages. `apipatch --version` returned `0.1.0-beta.4`. |
| Installed demo | `apipatch demo --verify-level4` exited 0 with all checks passed, and `apipatch --lang es demo` exited 0 with a Spanish summary. Two ambiguous findings remained pending, as designed. |

Level 4 tests only the packaged synthetic contract. In the standalone example verification, level 3 is blocked by pre-existing fixture type errors and level 5 is skipped; see [verification.json](../examples/demo/verification.json). The [compatibility matrix](COMPATIBILITY.en.md) lists other limits.

Installation from the npm registry (`npm install -g apipatch@beta`) cannot be observed until the package is published; the checks above install the same tarball as a local file. The development machine's npm configuration rejects direct remote-tarball URLs with `EALLOWREMOTE`, so the documented tarball route downloads first and installs the local file. Technical evidence and some diagnostics are retained verbatim and may remain in Spanish.
