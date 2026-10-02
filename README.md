# APIPatch

[English](README.md) · [Español](README.es.md)

APIPatch compares two OpenAPI definitions, locates affected JavaScript/TypeScript HTTP calls, and prepares reviewable code patches. It runs locally without an account, model API, or paid service. Repairs require explicit migration mappings; ambiguous changes remain pending.

**Public beta 0.1.0-beta.4.** Install from npm with Node.js 24 or later:

    npm install -g apipatch@beta
    apipatch demo --verify-level4

Or download the tarball from the [GitHub release](https://github.com/IgorPrieto/api-patch/releases/tag/v0.1.0-beta.4):

    curl -fL -o apipatch-0.1.0-beta.4.tgz https://github.com/IgorPrieto/api-patch/releases/download/v0.1.0-beta.4/apipatch-0.1.0-beta.4.tgz
    npm install -g ./apipatch-0.1.0-beta.4.tgz

The release includes SHA256SUMS.txt so you can verify the download. See the [release process](docs/RELEASING.md) for how npm versions are published. APIPatch does not upload repository code or send telemetry. See the [public beta testing guide](docs/PUBLIC_BETA.md) and [feedback forms](https://github.com/IgorPrieto/api-patch/issues/new/choose).

## Install from source

Clone this repository, then run:

    npm ci
    npm run build
    node dist/cli/main.js --help

The examples below use the installed apipatch command. If you built from source, replace it with node dist/cli/main.js.
English is the default language for human-readable CLI output and the browser panel. Use `apipatch --lang es demo --verify-level4` for Spanish CLI summaries, or select **Español** in the panel. Structured JSON and source evidence are not translated; some generated explanations and diagnostics remain in Spanish and are labeled as verbatim in the panel.

## Reproduce the demo

    apipatch demo --verify-level4

The data is **synthetic**. The demo runs an old consumer against API v1 and v2, shows concrete failures on v2, identifies affected calls, and applies supported repairs only to a temporary copy. It leaves two ambiguous findings pending. Level 4 verifies only the packaged synthetic contract; it is not a general contract-test runner or proof of production compatibility. See the [demo walkthrough](demo/README.en.md).

## Analyze your own repository

Use a copy or working branch of a JavaScript/TypeScript consumer and two OpenAPI 3.0 or 3.1 files in JSON or YAML:

    apipatch compare --old api-v1.yaml --new api-v2.yaml --json
    apipatch scan --old api-v1.yaml --new api-v2.yaml --repo ./my-app --base-url https://api.example.test --out ./apipatch-output/report.json
    apipatch report --input ./apipatch-output/report.json --format markdown --out ./apipatch-output/report.md

The optional base URL helps resolve relative calls. Analysis reads source files but does not import modules, compile the consumer, or run its scripts. Unresolved URLs and methods are reported with low confidence or left unassociated. The [compatibility matrix](docs/COMPATIBILITY.en.md) lists supported patterns and manual-review cases.

Compare and scan can use --fail-on breaking (exit 2 for breaking changes) or --fail-on ambiguous (exit 2 for breaking or ambiguous changes). Without a threshold, valid analyses exit 0 even when changes are found. Invalid input exits 1.

## Preview, verify, and apply a repair

Create a [migration file](docs/MIGRATION.en.md) with mappings confirmed by the API owner or your team:

    apipatch repair --report ./apipatch-output/report.json --migration ./migration.yaml --repo ./my-app --out ./apipatch-output
    apipatch verify --plan ./apipatch-output/plan.json --repo ./my-app --json

Repair writes plan.json and repair.patch without changing the consumer. Review the diff and pending findings before explicitly applying it:

    apipatch repair --apply ./apipatch-output/plan.json --repo ./my-app

Application checks the analyzed file hashes and refuses changed or unsafe paths. A successful application writes plan.applied.json next to the original plan unless --applied-out is supplied. To authorize one specific repository command afterwards:

    apipatch verify --plan ./apipatch-output/plan.applied.json --repo ./my-app --allow-repo-command --command npm --arg=test

That command runs npm test in ./my-app. Use it only when you trust the repository scripts. Verification distinguishes plan validity, syntax, applicable type checks, the opt-in synthetic demo contract, and an explicitly authorized repository command. Skipped and blocked levels are not successes. A failed level exits 4; a blocked level exits 5. Scanning never runs repository scripts.

## Local review panel

    apipatch ui --workspace . --port 0

Open the localhost URL printed by the CLI, including its session-token fragment. The browser can select files only within the chosen workspace. The panel displays changes, affected files, evidence, code diffs, verification results, exports, and an explicit apply control. The panel does not run repository test commands.

## Feedback and limits

Start with the [15–30 minute beta protocol](docs/PUBLIC_BETA.md). The [first-user guide](docs/FIRST_USER.en.md) and [pilot protocol](docs/PILOT.en.md) describe interviews and metrics without claiming commercial results. Send only minimal synthetic reproductions through the [issue forms](https://github.com/IgorPrieto/api-patch/issues/new/choose); do not post private specifications, customer code, or credentials. For vulnerabilities, use [private reporting](SECURITY.md).

This beta does not infer semantic renames, repair authentication changes, compare every JSON Schema construct, or resolve arbitrary wrappers and dynamic URLs. Its general contract-test level is not implemented; level 4 covers only the packaged demo. See the [compatibility matrix](docs/COMPATIBILITY.en.md), [validation record](docs/VALIDATION.md), [architecture](docs/ARCHITECTURE.en.md), [sample report and patch](examples/demo/README.en.md), [MIT license](LICENSE), and [dependency notices](THIRD_PARTY_NOTICES.md). The [reconstructed public API case](examples/public-case/README.en.md) uses a documented GitHub API announcement and synthetic inputs; it is not a production integration test.
