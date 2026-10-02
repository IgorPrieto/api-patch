# Announcement draft (not posted to communities)

**Show HN: APIPatch — find API consumers affected by an OpenAPI change and review a patch**

I built APIPatch, a local CLI and browser review panel for JavaScript/TypeScript consumers using fetch or axios. Give it two OpenAPI 3.0/3.1 files and a local repository; it classifies changes, points to affected calls with evidence, and prepares a patch only when you provide explicit migration mappings. Ambiguous cases remain pending.

The beta works without an account, model API, or hosted service. You can run the synthetic before/after demo with `apipatch demo --verify-level4`, then try your own repository. The contract test level currently applies only to the packaged demo; it does not prove production compatibility. Source, installation, and compatibility matrix: https://github.com/IgorPrieto/api-patch

I would especially value reports of affected calls it missed, false positives, and patches you had to edit or reject. Please share a minimal synthetic reproduction rather than private API definitions or source code.

---

Post only after checking the installation link and being ready to respond to comments. This draft makes no claim about users, time savings, or accuracy that has not been measured.
