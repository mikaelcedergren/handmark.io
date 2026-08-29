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

## Production runtime and evidence

The supported production runtime is the selected immutable compiled server backed by
`data/handmark.sqlite`. Source files and tracked service definitions are configuration evidence,
not proof of what is selected, installed, or running. Exact import, backup, cutover, release, and
runtime evidence lives only in the root
[`WEB-ARCHITECTURE-MIGRATION.md`](../WEB-ARCHITECTURE-MIGRATION.md).

Do not inspect live application data, create or replace the production SQLite target, remove legacy
evidence, or change launchd as part of ordinary source work. The completed one-time migration
procedure and its durable rollback boundaries are retained in
[`docs/application-storage-cutover.md`](docs/application-storage-cutover.md).
The tracked `launchd/com.handmark.server.plist` is a historical legacy recovery input, not a
byte-exact copy of the deleted installed definition;
`launchd/com.handmark.server.target.plist` is the validated immutable-server target.
`bin/install-server-daemon --check` is non-mutating, while `--apply` can install only the target
definition after the unloaded-service, selected-release, private-file, and database preconditions
pass. Run the applied form directly as `cortex`, never through `sudo`. The write is delegated to
the shared server-ops LaunchDaemon-definition transaction after shared server-release status has
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
flow; port `3000` remains reserved for Handmark. In ordinary production, its only private runtime
file is an owned mode-`0600` `.env.web` containing
`HANDMARK_PASSWORD` and `SESSION_SECRET`, documented without secrets in
[`.env.web.example`](.env.web.example). The existing `.env.example` and preserved operational
`.env` belong solely to the historical legacy recovery input; the compiled target never reads
legacy `.env` as a fallback.

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

The compiled importer entrypoint can be built and invoked explicitly for synthetic local work:

```bash
corepack pnpm build:server
node server/dist/import-applications.js \
  --operational-root /absolute/path/to/handmark.io \
  --source /absolute/path/to/applications.jsonl \
  --database /absolute/path/to/handmark.sqlite
```

When the stopped legacy service has an honestly empty queue and the authoritative JSONL therefore
does not exist, the runbook selects the separate `--empty-authority` form. That mode proves the
path remains absent and seals that fact; it never creates a fake empty JSONL. A present zero-byte
JSONL uses the ordinary JSONL form because present-file and absent-file authority are deliberately
not interchangeable. The importer accepts only the canonical `applications.jsonl` path beside the
target database, so another absent filename cannot be sealed as legacy authority.

Do not point that mutable-checkout command at operational data. The authorised stopped-daemon
procedure authenticates and invokes the importer and verifier from one exact sealed inactive
server candidate; it never uses mutable `server/dist` as migration authority.
Ordinary production always requires an existing selected database with the sealed legacy import
receipt and matching authority kind. JSONL authority requires `applications.jsonl` to remain
present and match its receipt's exact byte count and SHA-256; deleting it fails startup.
Empty-absence authority requires that path to remain absent. Evidence removal requires a future
explicit schema migration that durably records its approval; absence alone is never treated as
approval. The complete source parent chain must stay inside the operational root without symlinks
or identity changes. The target checks that authority only at startup; SQLite is the sole
application store, with no JSONL fallback or dual write. Before publication, the importer proves
the operational root and safely narrows only the required descendant database-directory chain to
mode `0700`; it never widens permissions or changes the operational root. The database directory
chain and exact mode-`0600`, single-link database inode remain pinned through receipt verification,
SQLite open, and runtime. Development, `test`, and isolated release validation may create fresh
synthetic databases only through exclusive, no-follow preallocation before SQLite opens them.
Initial retention starts only after the listener binds, so an occupied port cannot mutate records.
Any failed proof exits before intake.

The importer, backup/restore, activation, verification, and rollback sequence is owned only by
[`docs/application-storage-cutover.md`](docs/application-storage-cutover.md).

That procedure captures the importer's private single-line receipt, then uses the compiled
read-only verifier on both the published target and the first extracted SQLite backup. Operational
proof always runs through the authenticated inactive-candidate runner with the exact commands in
the cutover document; direct mutable-checkout `server/dist` execution is only a synthetic local
development interface and is never migration evidence.

The verifier reads no JSONL source and prints no application content. It reproduces only the sealed
receipt after proving the exact schema and migration ledger, SQLite integrity and foreign keys,
sealed authority, bounded canonical rows, sequence, projections, and hashes without creating
sidecars or changing the database. It rejects case-insensitive sidecar names and bounds every
directory inventory by both entry count and encoded filename bytes. It is a one-time
pre-activation proof, not a runtime database opener.

## Domain, hosting, and releases

Handmark's HTTPS hostnames and nginx route remain configured at `handmark.io` and
`www.handmark.io`. The repo-specific target, daemon label, and active nginx file are recorded in
[`DOMAIN_SETUP.md`](DOMAIN_SETUP.md). Shared network, release, restart, health, and rollback rules
stay in [`GO-LIVE.md`](../GO-LIVE.md) and [`SERVER-STANDARD.md`](../SERVER-STANDARD.md).

Browser assets for a change proved browser-only use the registered atomic release command:

```bash
node ../server-ops/bin/site-release.mjs --site handmark --browser-only --apply
```

That command does not publish, select, or restart the compiled server. A change proved server-only
uses the shared server-release flow. A change that affects both closures, or whose closure remains
uncertain, uses the paired transaction. Exact current release and runtime evidence stays in the
root migration ledger.

## Real payment next step

The current form records an application and selected review path. To charge the review fee or
subscription, add Stripe Checkout or another payment provider. Do not collect raw card details in
this app.
