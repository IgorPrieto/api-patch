# Releasing APIPatch to npm

[English](RELEASING.md) · [Español](RELEASING.es.md)

APIPatch is published as the unscoped package `apipatch`. Prereleases (`0.1.0-beta.N`) use the `beta` dist-tag; only stable versions use `latest`. `npm publish` refuses a prerelease without `--tag beta` (`scripts/check-dist-tag.mjs`, run by `prepublishOnly`), because npm ignores `publishConfig.tag`. `prepack` rebuilds `dist` so a tarball never ships stale output.

## Checklist for every release

1. `package.json` version, `docs/RELEASE_NOTES*.md`, and README install lines agree.
2. `npm ci && npm run check` passes locally and in CI (Node 24 and 26, including the panel e2e tests).
3. `npm pack`, install the tarball in an empty directory, then run `npx apipatch --version` and `npx apipatch demo --verify-level4`.
4. `npm publish --dry-run --tag beta` shows the expected file list (about 130 files, under 300 kB packed) and the `beta` tag.

## First publication (manual, once)

Trusted publishing can only be configured for a package that already exists on npm, so the very first version is published by a maintainer:

    npm login                      # account with 2FA enabled
    git checkout v0.1.0-beta.4 && npm ci && npm run check
    npm publish --tag beta --access public

Then, on npmjs.com → package `apipatch` → Settings → Trusted publishing, add GitHub Actions with repository `IgorPrieto/api-patch`, workflow `publish.yml` and environment `npm`. Create the `npm` environment in the GitHub repository settings (optionally with required reviewers). After that, set the package's publishing access to require 2FA and disallow tokens.

## Later releases (automated)

Publishing a GitHub release whose tag is `v<package.json version>` runs `.github/workflows/publish.yml`: `npm ci`, `npm run check`, tag/version check, then `npm publish --provenance` with `beta` for prereleases or `latest` otherwise. A manual run (`workflow_dispatch`) is a dry run unless `dry_run` is unchecked. `NPM_TOKEN` is only a fallback if trusted publishing is not configured.

Never publish from a dirty working tree. To withdraw a broken version within 72 hours use `npm unpublish apipatch@<version>`; afterwards use `npm deprecate`.
