# Handmark.io — agent entry point

## North star

Handmark is a protected early product and application flow for a selective trust mark: verification that work was made by a human.

The brand idea is not "anti-tooling" for its own sake. Handmark validates human authorship, human effort, and human care. A person must still be responsible for the meaningful decisions behind the work. No one should receive the mark unless they prove, to a satisfactory standard, that the work is human-made and has no substantial AI replacing the authorship.

The public page should feel like the front door of a coherent company, not a demo. It must sell the concept clearly: human stuff for humans, backed by rigorous review.

## Current product shape

- One password-protected early product.
- One public sales page after login.
- One initial review path: `$99` human review, followed by `$79/mo` membership only if approved.
- One application flow, stored locally.
- No self-serve stamp issuance. Submitted proof starts the review, but it does not replace direct contact.
- Handmark contacts the applicant and asks them to walk through the process, digitally or in person, before approval.
- If approved, the verification membership continues at `$79/mo`. If not approved, no subscription starts and no stamp is issued.
- No tiers. The applicant either proves the human-made claim and uses the mark, or they do not.

## Runtime and source architecture

Handmark follows the shared web architecture in [`WEB-ARCHITECTURE.md`](../WEB-ARCHITECTURE.md).
The root owns the Angular browser and product manifest; the `server` workspace owns one strict
NodeNext TypeScript backend. Production source is compiled before it runs. Do not add a TypeScript
loader, browser dependency, sibling-repo import, or second server implementation to the target
architecture.

- Product contract: `cx-product.json`
- Server source: `server/src/`
- Compiled server entry: `server/dist/index.js`
- Angular source: `src/`
- Static public assets: `public/assets/`
- Target application database: `data/handmark.sqlite`
- Registered production service target: `http://127.0.0.1:3000`
- In ordinary production, the compiled target reads `HANDMARK_PASSWORD` and `SESSION_SECRET` only
  from an owned mode-`0600` `.env.web`; do not place either value in launchd or docs.

The server composes the published Node-only cx-framework entrypoints for configuration, gate
authentication, cookies, request IDs, origin enforcement, JSON errors, rate limits, security,
health, static releases, server identity, listener startup, and graceful shutdown. Handmark owns
only its product manifest assertion, branded gate presentation, application validation/service,
SQLite repository/schema, and the offline legacy importer.

`NODE_ENV` accepts only the exact values `development`, `test`, or `production`; omission means
`development`. Isolated release validation still uses `NODE_ENV=production` and requires the
separate framework validation flag. "Ordinary production" below means production without that
isolated validation flag. Development, tests, and isolated release validation supply explicit
synthetic values and do not read either target or legacy private files.

For isolated local development, use:

```bash
pnpm dev
```

That command uses the reserved development port `4230` and `.run/dev/data`; it must not read or
write production `data/`. `pnpm start` is the canonical compiled entrypoint after `pnpm build`, but
do not start it casually on the Mac mini because `3000` is Handmark's reserved production port and
ordinary operation uses the selected service-release flow.

Browser publication for a change proved browser-only remains:

```bash
node ../server-ops/bin/site-release.mjs --site handmark --browser-only --apply
```

Browser-only publication does not select or restart a server release. A change proved server-only
uses the shared server-release flow. A change that affects both closures, or whose closure remains
uncertain, uses the paired transaction. The shared browser/server release, restart, identity, and
rollback contracts are owned by
[`SERVER-STANDARD.md`](../SERVER-STANDARD.md); the Handmark application-data procedure is
[`docs/application-storage-cutover.md`](docs/application-storage-cutover.md).

### Production selection and legacy evidence

The supported production target is the selected immutable `current-server` artifact executed by
`com.handmark.server`. Source files and tracked definitions never prove what is selected, installed,
or running; exact operational evidence lives only in the root
[`WEB-ARCHITECTURE-MIGRATION.md`](../WEB-ARCHITECTURE-MIGRATION.md).

`server/index.mjs`, `data/applications.jsonl`, legacy `.env`, and the tracked historical launchd
template are legacy recovery and migration evidence, not the target runtime. The deleted installed
legacy plist was not captured byte-for-byte, so the tracked template must never be described as an
exact installed-file rollback. `launchd/com.handmark.server.target.plist` is the validated
immutable-server target. `bin/install-server-daemon --check` validates both tracked definitions
without installing, unloading, loading, or restarting anything. `--apply` requires the role to be
unloaded, an immutable server release selected, and the private target files present. Run it
directly as `cortex`, never through `sudo`. It delegates the only definition write to the shared
server-ops LaunchDaemon installer after shared server-release status authenticates the selected
closure; it never loads or restarts the service. The compiled target never reads legacy `.env` as a
fallback.

Ordinary source work must not inspect or modify operational applications or SQLite state, alter the
backup registry, select a server release, or restart the daemon. Keep `HOST=127.0.0.1`; public
traffic reaches nginx first.

## Hosting and domain reality

Handmark's HTTPS hostnames and nginx route use the shared static-IP path. The path itself (static
IP, router forwarding, nginx as the only public gateway, and the nginx include model) is owned by
the root docs — see the root `AGENTS.md` ("Static IP state") and `GO-LIVE.md`. The selected
`com.handmark.server` service targets `127.0.0.1:3000`; repo routing values are in
`DOMAIN_SETUP.md`, while current runtime evidence remains in the root migration ledger. Do not
interrupt existing servers.

Important constraints:

- Do not destroy, replace, or disrupt `localgate.io`.
- Do not stop nginx unless the user explicitly asks and understands the impact.
- If nginx changes are needed, add or edit only the Handmark server block, validate with nginx's config test, then reload. Prefer reload over restart.
- Handmark's nginx target should remain `127.0.0.1:3000`.
- GitHub stores code; GitHub does not point the domain to this local Node API.

## Data, secrets, and git hygiene

- Target server secrets belong in `.env.web`, never in committed files. The file may contain only
  `HANDMARK_PASSWORD` and `SESSION_SECRET` and must be one owned mode-`0600` regular file.
- `.env.web.example` documents the compiled target's private keys. The existing `.env.example` and
  preserved operational `.env` belong only to the historical legacy recovery input. Do not make
  either file a target-server fallback.
- `data/applications.jsonl` and `data/handmark.sqlite*` are operational application data. Never
  inspect, copy into fixtures, or commit them.
- Target intake is SQLite with explicit migrations, foreign keys, WAL, a busy timeout, monotonic
  `intake_sequence`, immutable canonical record bytes/hashes, a 90-day retention rule, a
  10,000-record/100 MiB logical ceiling, and bounded physical/journal storage. Routes never write
  around `server/src/application-service.ts` and `server/src/application-repository.ts`.
- Ordinary production startup always requires an existing SQLite database with the sealed legacy
  import receipt and its sealed authority kind. The authority is either an exact legacy JSONL file
  or the explicit, canonical absence of that file when the stopped legacy queue is honestly empty;
  absence is never represented by a fabricated zero-byte JSONL. JSONL authority requires that file
  to remain present and match the receipt's source byte count and SHA-256; deletion fails startup.
  Empty-absence authority requires the path to remain absent; a later appearing JSONL also fails
  startup. Evidence removal cannot be inferred from absence and therefore requires a future
  explicit schema migration that durably records its approval before the JSONL may be removed. The
  source or its proven absence is checked only during startup; it is never the application store,
  a fallback reader, or a dual-write target. Its parent chain must remain contained, real,
  non-symlinked, and identity-stable inside the operational root.
- The framework-owned SQLite opener proves the complete private directory chain and pins the main
  database plus every required rollback-journal, WAL, and SHM identity before writable use. A clean
  WAL database instead proves that its unused rollback-journal path stays absent. It re-proves that
  storage around every statement, preserves legitimate WAL recovery, and owns the exact sidecar
  lifecycle for every website. Handmark supplies only its product-specific sealed-receipt verifier;
  that verifier runs read-only through the exact connection that remains writable, before framework
  configuration or any product migration. A canonical earlier migration-ledger prefix is valid
  upgrade input; all pending migrations and final current-schema/unchanged-receipt proof share one
  atomic transaction. Ordinary production still requires the existing authority and never creates
  an empty main-database replacement.
- Initial retention runs only after the HTTP listener binds successfully. An occupied port therefore
  exits without deleting retention-boundary records or changing the sealed receipt.
- The target never dual-writes and never falls back to JSONL.
- The compiled importer requires one explicit authority mode. JSONL mode validates the complete
  bounded file before publication and imports every row transactionally. Empty-authority mode pins
  the already-existing source parent and proves the named JSONL remains absent throughout; it
  creates no stand-in file. Both modes seal the authority kind with the receipt, prove the result
  after reopening, and safely recover only their own identity-proven staging operation. Before any
  database publication, the importer descriptor-pins the operational root and database-directory
  chain. It never changes the operational root; it may only narrow owner-readable/writable/executable
  descendant directories to mode `0700` through their open descriptors, and fails rather than
  widening owner permissions. Its staging directory, database, and marker request their private
  modes at exclusive creation and then prove those exact modes. The documented one-time importer
  is an offline Node command, not the long-running server's sealed
  permission-model entrypoint: its private staged rollback-journal connection and immutable
  read-only reopen are bounded migration-only exceptions to the long-lived WAL opener because its
  crash-safe hard-link publication contract requires them. They close before activation and are
  unreachable from web/worker startup. The command also requires filesystem `fsync`, which Node
  disables under its permission model. Use
  [`docs/application-storage-cutover.md`](docs/application-storage-cutover.md); never improvise an
  online migration. Operational import and replay execute only through the shared authenticated
  offline candidate-tool runner against one source-identical inactive sealed release; never invoke
  mutable-checkout `server/dist` for the cutover.
- The compiled `verify-application-import` command is the only operator-facing read-only proof for
  the imported target and the database extracted from its first required `sqlite-online` backup.
  Given an explicit database and the exact private importer-receipt file, it opens only a canonical
  mode-`0600` single-link database through immutable SQLite, verifies the exact schema, migration
  ledger, integrity, foreign keys, sealed receipt/authority, canonical rows, sequence, projections,
  and hashes, and emits only the matching receipt. It never reads the JSONL source or exposes
  application content; database records remain internal to the bounded proof. It creates no
  sidecars, rejects case-insensitive sidecar names, bounds directory inventories by entry and name
  bytes, mutates no database, and never becomes a runtime opening path. Operational target and
  restore proofs use that same authenticated candidate-tool runner rather than direct artifact
  execution.
- Gate and intake abuse limits are framework-owned and bounded. Do not introduce a product-local
  request-state map.
- `test-results/` is generated. Do not commit it.
- Do not collect raw card details in this app. Add Stripe Checkout or another payment provider before real billing.
- The intended payment model is a `$99` review fee first, then `$79/mo` only after approval.
- Git is read-only by default. Do not stage, commit, push, reset, checkout, merge, rebase, or stash unless the user explicitly asks.

## Design standard

Treat this as a professional public sales page for a company with a thought-through concept. The UI bar is high.

The page should be:

- Minimal, deliberate, and premium.
- Night-mode first.
- Human and relatable without becoming sentimental.
- Conversion-focused without feeling like a generic SaaS page.
- CTA-light: one clear primary action in the hero, then the final form submit. Pricing facts and review requirements should read as supporting information, not extra buttons.
- Legible at every viewport, with controlled max widths and no full-screen line lengths.
- Responsive, including a working mobile hamburger and clear mobile conversion path.
- Coherent as a package: logo, stamp, proof-page mockup, copy, pricing, application, and review standard should all reinforce the same trust product.

Avoid:

- Generic checklist-heavy marketing.
- Placeholder-looking mockups.
- One-off visual hacks.
- Huge full-width cards or paragraphs.
- Incoherent nested cards.
- Quirks, novelty styling, or copy that sounds like an internal demo.

The current logo/stamp assets in `public/assets/` are SVG interpretations of the provided handmark direction. They can be refined, but keep the identity centered on the hand/stamp idea: made by human hands.

## Framework integrity

Cortex is the source of truth; `cx-framework` is its packaged contract; Handmark is only a consumer.
The package comes from GitHub `main`; local styles may compose tokens but never redefine framework
behaviour.

- Never modify, reference, fork, or optimise Cortex or `cx-framework` from this repository.
- Consumers adapt forward. Never preserve an old contract with compatibility layers, aliases,
  wrappers, redirects, overrides, or temporary framework hacks.
- If the framework is missing something, document it under **🚨 Cortex Action Required** and stop;
  never recreate it locally.
- Prefer simpler architecture and deletion over preserving behaviour. Keep one implementation and
  remove verified dead, duplicate, obsolete, compatibility, legacy, and deprecated code.
- Evidence beats assumptions: uncertain removals are reported, not guessed.
- Add a shared abstraction only when it clearly simplifies today's system. Optimise for five-year
  maintainability, not today's convenience.
- Tokens carry intent. Components and sections stay sealed; no deep overrides or specificity fights.
- The page is the product spec: anything that does not support the trust-mark concept does not belong.

## Key files

- `cx-product.json` — declared Handmark product capabilities.
- `server/src/environment-files.ts` — strict target-only `.env.web` allowlist and shared private-file
  loader composition.
- `server/src/index.ts` — private-file loading followed by the compiled process entry.
- `server/src/runtime.ts` — product runtime composition and lifecycle.
- `server/src/app.ts` — HTTP composition around shared framework middleware.
- `server/src/gate-presentation.ts` — bounded branded presentation for the framework-owned gate.
- `server/src/application-*.ts` — validation, service, SQLite repository/schema, importer, and
  cutover interlock.
- `server/index.mjs`, `server/application-store.mjs`, and `server/request-limiter.mjs` — historical
  legacy recovery inputs; never the target source.
- `launchd/com.handmark.server.plist` — tracked historical legacy template and reviewed recovery
  input; it is not a byte-exact copy of the deleted installed definition.
- `launchd/com.handmark.server.target.plist` and `bin/install-server-daemon` — fail-closed target
  definition and definition-only installer for selected immutable server releases.
- `src/app/app.component.html` — protected sales page template.
- `src/app/app.component.ts` — menu and application submission behavior.
- `public/login.html` — historical legacy gate page; target gate HTML comes from
  `server/src/gate-presentation.ts` through cx-framework.
- `src/styles/site.scss` — global stylesheet entry; pulls in cx-framework tokens, base, fonts, and
  utilities, then the page composition. Angular compiles it into the stable `/styles.css` used by
  the framework-rendered gate and protected app; the historical legacy static gate also uses it.
- `src/styles/_page.scss` — Handmark page/login composition; arranges framework tokens and utilities only, defines no local design values.
- `angular.json` — copies the package-owned framework fonts to same-origin `/assets/fonts/` and the
  Handmark product assets to `/assets/`.
- `public/assets/handmark-logo.svg` — nav/login mark.
- `public/assets/handmark-symbol.svg` — light-background symbol.
- `public/assets/handmark-stamp.svg` — circular verification stamp.
- `public/assets/handmark-seal.svg` — compact seal for buyer-facing proof examples.
- `public/assets/handmark-og.png` — real 1200x630 OpenGraph image. Regenerate it after major brand/layout changes.
- `tests/e2e/handmark.spec.cjs` — Playwright verification.
- `ops/handmark.nginx.conf.example` — non-installable pointer to shared nginx ownership and
  Handmark-specific values.
- `DOMAIN_SETUP.md` — Handmark-specific routing values and verification contract.

## Application flow notes

The application form asks for the applicant, contact preference, brand/work name, kind of work, public URL, craft summary, proof links, and optional walkthrough preference. `src/app/app.component.ts` fills a few backend defaults for the early product:

- `billingCycle` defaults to `monthly`
- `paymentPreference` defaults to `after-approval`

The applicant must provide `contactPreference`, `brand`, and `category`. Direct contact is part of approval, so do not remove the contact field unless the review process changes. `walkthroughPreference` is optional but should be saved when present.

If you change the form, keep `src/app/app.component.*`, `server/src/application-validation.ts`, the
persisted record contract, and `tests/e2e/handmark.spec.cjs` aligned. Validation belongs before the
application service writes one atomic SQLite record.

## Verification

Use Playwright for UI verification. Do not claim a visual change is verified unless you actually ran it or explicitly say you could not.

The canonical non-destructive repository gate is:

```bash
pnpm check
```

It verifies formatting, the cx-framework product contract, strict browser/server TypeScript,
compiled server/importer contracts, deterministic tests, and the complete production build. CI
runs the same command on Node 26 before the isolated browser job.

Target server tests start only compiled JavaScript on loopback with ownership-proven operating-system
temporary roots, synthetic browser output, and synthetic SQLite databases. They cover the gate,
security/cache contract, signed-cookie tamper/restart behavior, mutation origins, shared errors,
SQLite intake/retention/health, listener failure, graceful shutdown, the startup receipt/source and
parent-containment interlocks, and exhaustive importer safety/parity. The separate
`tests/server/current-*` files remain legacy characterization evidence; they do not define the
target implementation.

Run the isolated Playwright script:

```bash
pnpm e2e
```

The Playwright config builds the browser and compiled server, serves on a dynamically assigned
runner-owned loopback port, blocks
external traffic, and keeps the browser, SQLite database, screenshots, and process state inside one
ownership-proven temporary root. The shared E2E range is disjoint from production port `3000`; the
suite also refuses the repo's production `data/` directory, then removes its complete runtime root.

The test covers:

- Branded framework-owned login gate, selective pre-auth assets, and no script on the gate page.
- Night-mode background.
- SEO metadata.
- Hero and proof-page sales flow.
- One membership only.
- Review fee and approval-gated subscription copy.
- Layout width constraints.
- Application submission and exact SQLite canonical-record/hash persistence.
- Shared JSON error and logout behavior.
- Mobile hamburger.
- `robots.txt` and `sitemap.xml`.

Screenshots are test artifacts inside the owned temporary E2E root and are removed by teardown.

## Local service checks

The canonical health check is `/healthz` and returns a JSON health payload:

```bash
curl -s http://127.0.0.1:3000/healthz
```

Useful checks:

```bash
curl -s -I http://127.0.0.1:3000/
curl -s -I -H 'Host: handmark.io' http://127.0.0.1/
curl -s -I -H 'Host: localgate.io' http://127.0.0.1/
```

Expected Handmark behavior before login (app-level check):

```text
HTTP 302
Location: /login
```

Expected localgate behavior is separate from Handmark. Do not "fix" localgate while working on Handmark unless the user specifically asks.

## Implementation preferences

- Keep this repo aligned with the shared Angular/Cortex-framework/server standard. Do not add one-off runtime patterns.
- Prefer small typed product modules composed around published framework primitives.
- Keep edits scoped to Handmark files.
- Keep comments sparse and useful.
- Use ASCII by default.
- Keep `SESSION_SECRET` at least 32 characters and `HANDMARK_PASSWORD` at least 12 characters when
  `NODE_ENV=production`; the development defaults are local-only.
- When changing the UI, update tests if the public contract changed.
- When changing domain/server setup, update `DOMAIN_SETUP.md`.

## Product copy guidance

Handmark should sound calm, serious, and human.

Use language around:

- human authorship
- human care
- effort
- craft
- proof
- review
- responsibility
- no proof, no stamp

Avoid language that makes Handmark sound like:

- a decorative badge marketplace
- an anti-AI manifesto
- a luxury gimmick
- a generic SaaS subscription
- an automated certification engine

The strongest positioning is:

```text
A public trust mark for work made by a person.
```

Everything else should support that sentence.
