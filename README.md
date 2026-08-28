# Handmark.io

Handmark is a protected early review and subscription product for verifying work that is actually
crafted by a human.

## Source architecture

- Angular 22 sales and application browser using the published cx-framework UI.
- One strict NodeNext TypeScript `server` workspace; production runs compiled
  `server/dist/index.js`, never a TypeScript loader.
- Published Node-only cx-framework contracts for the gate, cookies, request IDs, origins, JSON
  errors, rate limits, security, health, release identity, static serving, listener startup, and
  graceful shutdown, plus strict private-environment loading.
- Product-owned validation/service/repository layers for application intake.
- SQLite target storage at `data/handmark.sqlite`, with explicit migrations, monotonic intake
  sequence, immutable canonical record bytes/hashes, bounded retention/capacity, integrity-aware
  health, and no JSONL fallback or dual write.
- One offline, all-or-nothing importer that validates the complete bounded historical JSONL,
  publishes an exact SQLite result with an immutable receipt, and proves the reopened record set.

The permanent family architecture is owned by
[`WEB-ARCHITECTURE.md`](../WEB-ARCHITECTURE.md). Handmark-specific working rules are in
[`AGENTS.md`](AGENTS.md).

## Operational status

The target source architecture is implemented but has **not been selected in production**. The
live `com.handmark.server` daemon still runs the legacy `server/index.mjs` process and writes
`data/applications.jsonl`. The operational JSONL remains authoritative until the separately
authorised data import, backup/restore proof, server-release selection, and daemon restart all
complete.

Do not inspect live application data, create the production SQLite target, remove the legacy files,
change launchd, or claim the migration ran as part of ordinary source work. The exact future
procedure is [`docs/application-storage-cutover.md`](docs/application-storage-cutover.md).
The existing `launchd/com.handmark.server.plist` remains the rollback-owned legacy definition;
`launchd/com.handmark.server.target.plist` is the separately validated immutable-server candidate.
`bin/install-server-daemon --check` is non-mutating, while `--apply` can install only the target
definition after the stopped-service, selected-release, private-file, and database preconditions
pass. Run the applied form directly as `cortex`, never through `sudo`. The write is delegated to the
shared server-ops LaunchDaemon-definition transaction after the shared server-release status has
authenticated the selected closure; neither mode loads or restarts the service.

## Review and pricing model

- The initial human review currently costs `$99`.
- Submitted proof is only the starting point. Handmark contacts the applicant directly and asks them to walk through the process before approval.
- The application form asks for applicant identity, contact preference, work category, proof links, and optional walkthrough preference because direct contact is part of the review.
- If the applicant is approved, the verification membership continues at `$79/mo`.
- If the applicant is not approved, no subscription starts and no stamp is issued.

## Work locally

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:4230` and enter the local development password. Development is isolated in
`.run/dev/` and must never use production port `3000` or production `data/`.
`NODE_ENV` accepts exactly `development`, `test`, or `production`; omission means `development`,
and isolated release validation requires `production` plus its separate framework flag.

Canonical commands:

```bash
pnpm dev
pnpm build
pnpm start
pnpm typecheck
pnpm test
pnpm e2e
pnpm format:check
pnpm check
```

`pnpm start` is the compiled production entrypoint and expects a completed build and an appropriate
release/runtime environment. On the Mac mini, use it only through the authorised server-release
flow because the live service already owns port `3000`. In ordinary production, its only private
runtime file is an owned mode-`0600` `.env.web` containing `HANDMARK_PASSWORD` and `SESSION_SECRET`,
documented without secrets in [`.env.web.example`](.env.web.example). The existing `.env.example`
belongs solely to the still-selected legacy MJS daemon; the compiled target never reads legacy
`.env` as a fallback.

## Build and verify

```bash
pnpm check
pnpm e2e
```

`pnpm check` is the non-destructive repository gate. The server contracts and Playwright suite use
compiled JavaScript, loopback-only processes, synthetic fixtures, owned operating-system temporary
roots, and SQLite databases outside production. E2E blocks external traffic and refuses production
port/data paths.

## Application import and cutover

The compiled importer entrypoint is built and invoked explicitly:

```bash
corepack pnpm build:server
node server/dist/import-applications.js \
  --source /absolute/path/to/applications.jsonl \
  --database /absolute/path/to/handmark.sqlite
```

Do not point that command at operational data outside the authorised, stopped-daemon procedure.
Ordinary production always requires an existing selected database with the sealed legacy import
receipt, even after `applications.jsonl` is intentionally removed. While the JSONL remains, its
exact byte count and SHA-256 must match that receipt, and its complete parent-directory chain must
stay inside the operational root without symlinks or identity changes. The target reads it only at
startup as an integrity witness; SQLite is the sole application store, with no JSONL fallback or
dual write. The database directory chain and exact mode-`0600`, single-link database inode remain
pinned through receipt verification, SQLite open, and runtime. Development, `test`, and isolated
release validation may create fresh synthetic databases only through exclusive, no-follow
preallocation before SQLite opens them. Initial retention starts only after the listener binds, so
an occupied port cannot mutate records. Any failed proof exits before intake.

The importer, backup/restore, activation, verification, and rollback sequence is owned only by
[`docs/application-storage-cutover.md`](docs/application-storage-cutover.md).

## Domain, hosting, and releases

Handmark is live at `handmark.io` and `www.handmark.io`; the repo-specific target, daemon label, and
active nginx file are recorded in [`DOMAIN_SETUP.md`](DOMAIN_SETUP.md). Shared network, release,
restart, health, and rollback rules stay in [`GO-LIVE.md`](../GO-LIVE.md) and
[`SERVER-STANDARD.md`](../SERVER-STANDARD.md).

Browser assets for a change proved browser-only use the registered atomic release command:

```bash
node ../server-ops/bin/site-release.mjs --site handmark --browser-only --apply
```

That command does not publish, select, or restart the compiled server. A change that can affect
both sides uses the paired transaction. The target cutover remains blocked by the migration ledger
and requires the separate authorised data and operational flow.

## Real payment next step

The current form records an application and selected review path. To charge the review fee or
subscription, add Stripe Checkout or another payment provider. Do not collect raw card details in
this app.
