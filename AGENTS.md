# Handmark.io — agent entry point

## North star

Handmark is a selective trust mark for work made by a person. It validates human authorship,
effort, care, and responsibility. It is not anti-tooling for its own sake, and submitted material
never replaces direct human review.

The public page should feel like the front door of a coherent company, not a demo. The strongest
positioning is:

```text
A public trust mark for work made by a person.
```

## Product contract

- One password-protected early product.
- One public sales page after login.
- One `$99` human review.
- Direct contact and a process walkthrough before approval.
- One `$79/mo` membership only after approval.
- No tiers and no self-serve stamp issuance.
- Rejection means no subscription and no stamp.

The owner sets product direction, business intent, and design intent. The agent owns implementation,
architecture, tests, documentation, deployment, reliability, and routine system operation under
the shared development-root ownership model.

## Architecture

Handmark follows [`WEB-ARCHITECTURE.md`](../WEB-ARCHITECTURE.md) and
[`SERVER-STANDARD.md`](../SERVER-STANDARD.md):

- Product contract: `cx-product.json`
- Angular browser: `src/`
- Compiled NodeNext TypeScript server: `server/src/` → `server/dist/`
- Production application database: `data/handmark.sqlite`
- Production listener: `127.0.0.1:3000`
- Production service: `com.handmark.server`
- Current service definition: `launchd/com.handmark.server.plist`
- Product-specific routing: `DOMAIN_SETUP.md`

The server composes the published Node-only cx-framework entrypoints for configuration,
authentication, cookies, request IDs, origin enforcement, JSON errors, rate limits, security,
health, static releases, server identity, listener startup, and graceful shutdown. Handmark owns
only its manifest assertion, branded gate presentation, application validation/service, and SQLite
repository/schema.

There is exactly one runtime and one application store. Do not add a second server, data reader or
writer, dual write, fallback store, import operator, compatibility layer, or tracked application
rollback implementation. Applied migrations remain byte-stable because their fingerprints are
required to open existing SQLite databases; current runtime behavior depends only on the current
schema.

Production requires the existing `data/handmark.sqlite` and must fail rather than create an empty
replacement. Development, tests, and isolated release validation use synthetic data outside
production `data/`.

## Framework boundary

Cortex is the source, `cx-framework` is the portable published contract, and Handmark is a
consumer.

- Consume only explicit `@mikaelcedergren/cx-framework` entrypoints from GitHub `main`.
- Never import Cortex or another sibling repository directly.
- Consumers migrate forward; do not add aliases, shims, redirects, fallbacks, or overrides for an
  old framework contract.
- Search the framework and repo-local shared layers before adding custom code.
- If a reusable capability is genuinely missing, report it as **🚨 Cortex Action Required** and
  stop rather than recreating it locally.
- Keep code simple, clean, consistent, typed, and deletion-friendly. A locally clever exception is
  worse than the established family pattern.

## Data and secrets

- Never inspect, print, copy into fixtures, or commit production application content.
- `data/` is operational state and is ignored in full.
- `.env.web` is the only production private environment file. It may contain only
  `HANDMARK_PASSWORD` and `SESSION_SECRET`, must be one owned mode-`0600` regular file, and is never
  committed.
- The database uses explicit migrations, foreign keys, WAL, a busy timeout, immutable canonical
  record bytes/hashes, monotonic intake sequence, 90-day retention, 10,000-record and 100 MiB
  logical ceilings, plus bounded physical/journal storage.
- Routes write only through `application-service.ts` and `application-repository.ts`.
- Framework-owned SQLite storage proofs pin the database and sidecars around every operation.
- Retention starts only after the listener binds so a failed listener cannot mutate data.
- Runtime data remains covered by the shared backup and bounded-storage contracts. Backups protect
  the current architecture; they are not a reason to retain obsolete source or operators.
- Never collect raw card details. Add a hosted payment provider before real billing.

## Environment

`NODE_ENV` accepts only `development`, `test`, or `production`; omission means `development`.
Isolated release validation uses `NODE_ENV=production` plus the framework validation flag and owns
fresh unreachable credentials. Ordinary production reads real credentials only through
`server/src/environment-files.ts`.

Local development:

```bash
pnpm dev
```

This uses `127.0.0.1:4230` and `.run/dev/data`. Do not casually run `pnpm start` on the Mac mini;
port `3000` belongs to the selected production service.

## Application flow

The form records applicant identity, contact preference, brand/work name, work category, public
URL, craft summary, proof links, and an optional walkthrough preference. Direct contact is part of
approval, so do not remove the contact field without a product decision.

The browser supplies these early-product defaults:

- `billingCycle`: `monthly`
- `paymentPreference`: `after-approval`

Keep `src/app/app.component.*`, `server/src/application-validation.ts`, the persisted record
contract, and `tests/e2e/handmark.spec.cjs` aligned. Validate before one atomic SQLite append.

## Design and copy

The UI must be minimal, deliberate, premium, night-mode first, legible at every viewport, and
conversion-focused without generic SaaS styling. Keep one primary hero action and one final form
submit. The logo, stamp, proof example, review requirements, pricing, and application should all
reinforce human authorship and rigorous review.

Use language around human authorship, human care, effort, craft, proof, review, responsibility, and
“no proof, no stamp.” Avoid decorative-badge marketplace language, anti-AI manifestos, luxury
gimmicks, and automated-certification claims.

Use European sentence case everywhere. Use framework tokens/components/patterns; never reach into
component internals, duplicate design values, or solve a shared defect with a page-level override.

## Key files

- `server/src/runtime.ts` — lifecycle composition.
- `server/src/app.ts` — HTTP composition.
- `server/src/environment-files.ts` — strict private environment loading.
- `server/src/application-schema.ts` — current SQLite schema and immutable migration ledger.
- `server/src/application-repository.ts` — storage ownership, retention, capacity, and health.
- `server/src/application-service.ts` — atomic application submission.
- `server/src/gate-presentation.ts` — branded framework-owned gate presentation.
- `src/app/app.component.*` — sales page and application behavior.
- `src/styles/site.scss` — framework styles plus product composition.
- `launchd/com.handmark.server.plist` — one current selected-release definition.
- `bin/install-server-daemon` — definition validation/installation only; never activation.

## Verification and delivery

The canonical non-destructive gate is:

```bash
pnpm check
```

For ordinary development changes, use the repository-owned change-aware proof:

```bash
pnpm verify:change
```

Its product-specific map and options are documented in `DEVELOPMENT-VERIFICATION.md`.

The isolated browser test is:

```bash
pnpm e2e
```

Tests must use compiled JavaScript, loopback-only processes, explicit synthetic environments,
owned OS temporary roots, and synthetic SQLite databases. They must never read production data or
secrets.

Classify every complete releasable change as browser-only, server-only, or paired. Use the shared
registered release operator for that class; never activate half of an uncertain change. Service
definition installation, service activation, release identity, health, backup, cleanup, and
public verification follow the root documents. A source build or local preview is not delivery.

Before claiming success, verify the requested route, `/healthz`, the selected browser/server
identities appropriate to the release class, local nginx routing, and public HTTPS behavior.

## Git

Follow the development-root Git policy. Work on the current branch, never create a branch, preserve
unrelated edits, and do not stage, commit, or push without the user's current explicit authority.
