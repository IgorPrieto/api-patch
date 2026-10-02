# A documented GitHub API change, reconstructed for APIPatch

[English](README.en.md) · [Español](README.md)

GitHub [announced on December 10, 2024](https://github.blog/changelog/2024-12-10-notice-of-breaking-changes-security-manager-rest-api-will-be-retired-and-replaced-with-the-organization-roles-rest-api/) that three security-manager endpoints would be retired, including `GET /orgs/{org}/security-managers/teams`. Its announcement listed December 31, 2025 for GitHub.com and named `GET /orgs/{org}/roles/{role_id}/teams` among the replacement organization-roles endpoints. This describes the announcement, not a live check of GitHub's current production behavior.

`old.yaml` and `new.yaml` are **our minimal reconstructions**, not GitHub-published OpenAPI snapshots. They contain only the paths and parameters needed to demonstrate a removed endpoint. `consumer.js` is synthetic and must not be run against GitHub. A path replacement alone cannot be assumed equivalent: the new route needs a `role_id`, whose value depends on the user's workflow. The finding therefore needs manual review and should not generate an automatic patch without a confirmed mapping and value.

After installing APIPatch, from the package root:

```sh
apipatch compare --old examples/public-case/old.yaml --new examples/public-case/new.yaml
apipatch scan --old examples/public-case/old.yaml --new examples/public-case/new.yaml --repo examples/public-case
```

A local check on 2026-10-01 produced two changes (one compatible added operation and one breaking removed operation), one HTTP use, and one finding tied to the removed operation. The checked-in [analysis.json](analysis.json) and [English report](report.en.md) contain those results. Absolute paths in those artifacts were normalized to `./` for publication; rerun the commands to obtain paths for your checkout. This case demonstrates local static analysis of a documented change, not a production integration test.
