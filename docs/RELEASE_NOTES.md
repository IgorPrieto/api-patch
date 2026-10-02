# APIPatch 0.1.0-beta.4

[English](RELEASE_NOTES.md) · [Español](RELEASE_NOTES.es.md)

This beta narrows three documented limitations and is the first version prepared for the npm registry.

- **Comparison.** Recursive schema references are now compared structurally with cycle detection, so a change behind a stable recursive reference is no longer missed; a reference that cannot be resolved is reported as ambiguous. Object-like `allOf` branches are merged and compared with the normal rules, and `anyOf` branch additions/removals are classified by direction. In OpenAPI 3.1, siblings of a recursive `$ref` are kept instead of dropped. `oneOf`, `not`, `if`/`then`/`else`, discriminator and non-mergeable `allOf` changes remain ambiguous.
- **Scanning.** Calls made through a repository-local wrapper (same file, or one relative import, including imported `axios.create` instances) are matched at each call site, carry a `via` reference to the wrapper and have at most medium confidence. A never-reassigned module-local `let` resolves like a constant. The call inside a wrapper keeps its own findings unless every caller is provably covered.
- **Repair.** Migration renames and values accept an optional `parent` path for nested request and response fields. APIPatch edits nested inline request objects, response property chains (including optional chaining and axios `response.data`), and `const`/`let` destructuring of the response. Calls through wrappers are reported but never edited.
- **Packaging.** `prepack` rebuilds `dist`; publishing a prerelease requires `--tag beta`; a GitHub Actions workflow publishes with npm provenance after the first release. See [RELEASING.md](RELEASING.md).

Install with Node.js 24 or later:

    npm install -g apipatch@beta
    apipatch demo --verify-level4

The tarball attached to the [GitHub release](https://github.com/IgorPrieto/api-patch/releases/tag/v0.1.0-beta.4) works too: `npm install -g ./apipatch-0.1.0-beta.4.tgz`.

Migration files from beta.3 remain valid (`schemaVersion` "1.0"; the new fields are optional). Reports may contain the new optional `via` field on uses, and the snapshot schemas of recursion targets carry an `x-apipatch-recursion-anchor` annotation.

Limitations: authentication changes are not repaired; semantic renames are never guessed; wrappers outside the single-call shape, chains of wrappers and re-exports need review; nested fields through arrays, `oneOf`/`anyOf` or recursive schemas are not repaired; JSON Schema comparison is still partial; contract verification level 4 only covers the synthetic demo. Passing local checks does not guarantee production compatibility. See the [compatibility matrix](COMPATIBILITY.en.md) and the [validation record](VALIDATION.md).

Previous: 0.1.0-beta.3 added the English documentation, CLI and panel, keeping Spanish as an option.
