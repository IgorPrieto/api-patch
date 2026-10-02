# Contributing to APIPatch

[English](CONTRIBUTING.md) · [Español](CONTRIBUTING.es.md)

Start with the [public beta guide](docs/PUBLIC_BETA.md) and [compatibility matrix](docs/COMPATIBILITY.en.md). A finding that remains pending within the declared matrix must not be presented as an automatic repair.

To develop: use Node.js 24 or later, run npm ci, npm run check, and node dist/cli/main.js demo --verify-level4. The test suite includes a browser walkthrough when Chrome or Chromium is installed; if it is absent, that test is skipped and you should say so when reporting results.

Open an issue with a minimal synthetic reproduction before proposing a broad change. A PR should explain the supported pattern, the AST/OpenAPI evidence behind it, cases that remain unresolved, and the checks run. Do not include credentials, private code, or customer reports without permission. For vulnerabilities, follow [SECURITY.md](SECURITY.md).

The code is distributed under [MIT](LICENSE). By contributing, you agree that your contribution will be distributed under that license.
