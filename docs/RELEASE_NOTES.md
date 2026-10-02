# APIPatch 0.1.0-beta.3

[English](RELEASE_NOTES.md) · [Español](RELEASE_NOTES.es.md)

This beta makes the public documentation, feedback forms, CLI summaries, Markdown reports, and review panel accessible in English while keeping Spanish documentation and a Spanish interface option (`--lang es` in the CLI, **Español** in the panel). APIPatch compares OpenAPI 3.0/3.1 JSON/YAML, matches changes to fetch/axios calls in JS/TS, and prepares patches from explicit mappings. It separates proposed, applied, verified, and pending states. The synthetic before/after demo and JSON, Markdown, and patch exports are included.

Install the attached tarball with Node.js 24 or later:

    curl -fL -o apipatch-0.1.0-beta.3.tgz https://github.com/IgorPrieto/api-patch/releases/download/v0.1.0-beta.3/apipatch-0.1.0-beta.3.tgz
    npm install -g ./apipatch-0.1.0-beta.3.tgz
    apipatch demo --verify-level4

The package is not yet in the npm registry. See the [beta test guide](PUBLIC_BETA.md), [compatibility matrix](COMPATIBILITY.en.md), and [validation record](VALIDATION.md). APIPatch does not upload code or send telemetry. Test your own consumer on a copy or branch and send feedback using a synthetic reproduction.

Limitations: dynamic URLs and wrappers need review; semantic renames are never guessed; authentication changes are not repaired automatically; JSON Schema comparison is partial; contract verification level 4 only covers the demo. Passing local checks does not guarantee production compatibility.
Technical evidence, generated explanations, and some diagnostics remain in their original language. The panel labels these as verbatim rather than claiming a complete translation of analysis data.
