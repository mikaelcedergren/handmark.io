# Change-aware development verification

Run `pnpm verify:change` after a coherent local change. It compares the exact current source with
the last successful proof, reuses checks only while their owned inputs are byte-identical, and runs
independent selected checks together. The first run deliberately executes the complete `pnpm check`
gate.

Useful controls:

```bash
pnpm verify:change --plan
pnpm verify:change --visual
pnpm verify:change --force
pnpm verify:change --full
```

## Handmark map

- Documentation uses formatting only.
- Styling and public-interface changes use formatting, types, a production browser build, and the
  authenticated real page in the already-running synthetic local environment on port `4230`.
- Application-form component changes additionally run Handmark's isolated E2E flow because the
  browser fields, validation contract, persisted record, and submission journey must stay aligned.
- E2E changes run the isolated repository-owned E2E command.
- Dependencies, repository authority, authentication, server and SQLite ownership, environment
  boundaries, installers, nginx/service/release definitions, server-rendering configuration, and
  this verifier's trust implementation use the complete `pnpm check` gate.
- Unclassified source changes fail conservatively into the complete gate.

The rendered proof may log into the fixed synthetic development environment. It never reads
production credentials or data and never starts, stops, or repairs the environment. Receipts and
screenshots stay in ignored `.run/verification/` with private permissions and must never be
committed.

The authoritative option meanings, hashing, evidence, escalation, and release-separation contract
lives in the Development root's
[`DEVELOPMENT-VERIFICATION.md`](https://github.com/mikaelcedergren/development-root/blob/main/DEVELOPMENT-VERIFICATION.md).
This file owns only Handmark's checks, paths, host restriction, and rendered route.
