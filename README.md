# Handmark.io

Handmark is a protected early review and subscription product for verifying work that is actually
crafted by a human.

## Product

- The initial human review costs `$99`.
- Submitted proof starts a human review and direct walkthrough; it never issues a mark
  automatically.
- Approved applicants continue at `$79/mo`.
- Rejected applicants are not subscribed and receive no stamp.

## Architecture

Handmark follows the shared family architecture in
[`WEB-ARCHITECTURE.md`](../WEB-ARCHITECTURE.md):

- Angular browser using the published `@mikaelcedergren/cx-framework` UI.
- One strict NodeNext TypeScript server compiled to `server/dist/index.js`.
- Framework-owned authentication, cookies, request IDs, origin enforcement, JSON errors, rate
  limits, security, health, static releases, server identity, listener startup, and shutdown.
- Product-owned application validation, service, and SQLite repository layers.
- One authoritative database at `data/handmark.sqlite`; production requires that existing database
  and never creates an empty replacement.
- Explicit SQLite migrations, immutable canonical application records, monotonic intake sequence,
  bounded retention/capacity, and integrity-aware health.

Applied migrations are immutable database history. The current schema, code, operator, service,
documentation, and backup policy have one SQLite authority and no alternate application store.

## Local development

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:4230`. Development data stays in `.run/dev/`; it must never use production
port `3000` or production `data/`.

Canonical commands:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm e2e
pnpm check
```

`pnpm check` is the complete non-destructive repository gate. Tests use compiled JavaScript,
loopback-only processes, synthetic SQLite databases, and owned temporary roots.

## Production

The selected immutable server release runs as `com.handmark.server` on `127.0.0.1:3000`. Its only
private environment file is an owned mode-`0600` `.env.web` containing `HANDMARK_PASSWORD` and
`SESSION_SECRET`; [`.env.web.example`](.env.web.example) documents the keys without secrets.

Validate or install the current service definition without loading or restarting it:

```bash
bin/install-server-daemon --check
bin/install-server-daemon --apply
```

Browser-only, server-only, and paired releases use the shared operators documented in
[`SERVER-STANDARD.md`](../SERVER-STANDARD.md). Handmark-specific routing values are in
[`DOMAIN_SETUP.md`](DOMAIN_SETUP.md). Runtime data is covered by the shared backup and bounded
storage contracts; source checkouts and tracked definitions are never treated as live-state proof.

## Payment boundary

The current form records an application and review path. Add Stripe Checkout or another payment
provider before charging either fee. Never collect raw card details in this application.
