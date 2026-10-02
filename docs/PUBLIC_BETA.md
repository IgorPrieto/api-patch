# Public beta: test APIPatch on a real API change

[English](PUBLIC_BETA.md) · [Español](PUBLIC_BETA.es.md)

APIPatch runs on your computer. We want to learn whether it finds affected consumer calls and produces patches a maintainer would accept. There is no automatic telemetry, account requirement, or code upload.

## A 15–30 minute test

1. Install the [beta release](https://github.com/IgorPrieto/api-patch/releases/tag/v0.1.0-beta.3) using the [README](../README.md). Run apipatch demo --verify-level4 to see what the verification states mean.
2. Choose two OpenAPI 3.0/3.1 versions and a **copy or working branch** of a JavaScript/TypeScript consumer using fetch or axios. Run compare and scan as shown in the README. Analysis does not execute the consumer.
3. Review high-confidence findings and pending cases. For each real change, record whether APIPatch found all affected calls, reported an unrelated call, or could not resolve a pattern you expected it to support.
4. If you know a confirmed migration mapping, configure it and generate a preview with repair. Review the diff. Apply only to the copy or branch you control; authorize repository tests only if you trust the command.
5. Tell us whether the patch was accepted unchanged, edited, rejected, or left pending. A synthetic demo or skipped verification level does not establish production compatibility.

## Send feedback

Use the [issue forms](https://github.com/IgorPrieto/api-patch/issues/new/choose) for a usage failure, missed affected call, or patch review. Include the Node version, operating system, APIPatch version, HTTP-call pattern, expected result, and observed result. If needed, share a **minimal synthetic reproduction**. Do not attach private OpenAPI files, secrets, credential-bearing URLs, or code you cannot publish.

You can report counts without posting source: affected calls reviewed, true positives, false positives, omissions, and patches accepted/edited/rejected. Label observed and estimated numbers separately. Downloads alone do not measure accuracy.

The [compatibility matrix](COMPATIBILITY.en.md) defines scope. Dynamic URLs, custom wrappers, authentication changes, and nested fields can require manual review. Report vulnerabilities through [private disclosure](../SECURITY.md), never through a public issue with exploit details.
