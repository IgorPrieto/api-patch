# First user trial

[English](FIRST_USER.en.md) · [Español](FIRST_USER.md)

Invite a team that maintains a JavaScript/TypeScript API integration and has old and new OpenAPI definitions to try APIPatch on a local working copy. The tool needs neither GitHub nor uploaded code. Allow 30–45 minutes; make no claim about time saved or detection accuracy before measuring it.

1. Install from the [README](../README.md) and run `apipatch demo`. Confirm that the output distinguishes repaired, ambiguous, skipped, and blocked results.
2. Run `compare` and `scan` against the team's definitions and a copy or branch of its consumer. Record affected calls found and unresolved calls. Ask the maintainer to identify false positives and missed uses; do not retroactively change the metric definition.
3. Choose a change with a mapping confirmed by the API owner. Create `migration.yaml` using report IDs, run `repair`, and review `plan.json` and `repair.patch` line by line. Low-confidence and ambiguous cases remain pending.
4. Run `verify` and record each level separately. If repository tests are desired, authorize a specific command in a controlled environment. Apply only to the chosen copy or branch. Run the team's own tests and, when available, test against the new API's sandbox. APIPatch assumes no production access.
5. Interview the maintainer about findings, explanations, pending cases, and the diff. Record time to a reviewed patch, comparable manual correction time, false positives, coverage of known HTTP uses, patches accepted or rejected, and reasons. Keep only consented counts and observations; code may remain on the user's machine.

Questions: “What was the last API change that broke your integration?” “How did you find the calls to inspect?” “What evidence would you need to accept a patch?” “Which part of this report is ambiguous or wrong?” The [pilot protocol](PILOT.en.md) separates commercial hypotheses from observed facts.

Three-minute demo: run `demo`; show v1 passing, v2 failing in concrete ways, five findings, and the pending `oneOf` case. Show the diff and the repaired copy passing 3/3 supported cases. End with the verification report and explain why blocked or skipped levels are not successes.
