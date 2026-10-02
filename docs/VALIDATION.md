# Observed validation — APIPatch 0.1.0-beta.3

Date: 2026-10-02. Local Linux x64 checks. They validate packaging and the synthetic demo, not production compatibility or adoption by real users.

| Check | Observed result |
| --- | --- |
| Dependency installation | `npm ci` exited 0; 41 packages installed; npm reported 0 vulnerabilities in that run. |
| Node 24.21.0 | `npm run check` exited 0: 15 test files, 178/178 tests passed. |
| Node 26.5.0 | `npm run check` exited 0: 15 test files, 178/178 tests passed. |
| Browser panel | Both local suites ran the real Chromium end-to-end test. The test analyzed and exported an English report, switched to Spanish and back, then exercised the Spanish analysis, patch preview, export, and explicit apply path. |
| Package contents | `npm pack --dry-run` included the CLI build, panel assets, English/Spanish docs, demo, and example reports. |
| Clean install | A generated `0.1.0-beta.3` tarball installed in a separate empty directory with five runtime packages. Its `apipatch --version` returned `0.1.0-beta.3`. |
| Installed demo | `apipatch demo --verify-level4` exited 0. The old consumer failed against v2, while the temporary repaired copy passed 3/3 supported cases; two ambiguous findings remained pending. |
| Language selection | The installed CLI produced a Spanish summary with `--lang es`; the default compare summary was also checked in English. The browser exported an English Markdown report. |

Level 4 tests only the packaged synthetic contract. In the standalone example verification, level 3 is blocked by pre-existing fixture type errors and level 5 is skipped; see [verification.json](../examples/demo/verification.json). The [compatibility matrix](COMPATIBILITY.en.md) lists other limits.

The development machine's npm configuration rejects direct remote-package installation with `EALLOWREMOTE`. The documented route downloads the tarball and installs it as a local file; it does not require an npm account. Technical evidence and some diagnostics are retained verbatim and may remain in Spanish.
