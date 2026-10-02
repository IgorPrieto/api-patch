# First users, interviews, and pilot

[English](PILOT.en.md) · [Español](PILOT.md)

## Target customer and hypotheses

The first person to interview maintains JavaScript/TypeScript integrations with OpenAPI-documented APIs and several call sites. The proposed problem: a contract change forces maintainers to find uses, decide migrations, and collect evidence that a patch is safe. This need has not been validated with real users.

Possible differentiators, **not measured market facts**:

- Connect each contract difference to concrete AST locations in consumer code, with evidence and confidence.
- Require explicit decisions for semantic migrations and leave ambiguous cases pending.
- Produce local diffs and reports with reproducible verification levels, without requiring a remote repository or model.

Compare competing tools later using the workflows interviewees actually use. Do not assume these capabilities are unique or that anyone will pay for them.

## Discovery interview (25 minutes)

1. Ask about the last breaking change in an API they consume: when they learned of it, the first signal, and its impact.
2. Walk through how they found all uses, who decided the migration, and which files changed. Record active time and waiting time separately.
3. Ask what evidence reviewers required to approve the patch, which checks were missing, and what remained manual.
4. Ask which tools they used and where false positives or missed changes occurred.
5. Show APIPatch last; ask for a candidate pilot integration and reasons they would not trust the result.

Do not request secrets or copy production repositories. Record answers with permission, separating quotes from interpretation.

## Local pilot

Define the OpenAPI versions, consumer copy, known base URLs, excluded directories, and any specific permission to run repository tests before the pilot. Keep a local case ID without publishing code. Establish a baseline for a comparable manual task first. Then run analysis and have the maintainer classify findings as correct, false positive, or not evaluable.

Classify each proposed patch as accepted unchanged, accepted with edits, rejected, or pending. Measure active manual analysis/repair time against the assisted workflow using the same start and end definitions. State sample size and task complexity. A synthetic demo is not a pilot.

## Metrics

| Metric | Definition | Avoid confusing with |
| --- | --- | --- |
| Time saved | Active minutes for comparable manual work minus active minutes with APIPatch | External waits and different scope |
| False positives | Adjudicated incorrect findings / adjudicated findings | Unreviewed findings are not counted as correct |
| Coverage | Affected uses detected / affected uses found by independent review | Spec changes with no consumer use |
| Patches accepted | Patches accepted unchanged / reviewed patches; track edited separately | Automatic application is not acceptance |

Also record unsupported missed patterns, check duration, and rejection reasons. There were no commercial measurements or user interviews when this document was written.

## Demonstration script

With the synthetic demo: show v1 working and v2 failing; run analysis and open the affected file and location; inspect the rule, confidence, and evidence; show the migration file and diff; apply to a copy; rerun checks and show which passed or were skipped. Close with the pending ambiguous case and a compatible change that raised no false alarm. Export the report for independent review.
