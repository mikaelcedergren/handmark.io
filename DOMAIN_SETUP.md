# Handmark.io domain setup

This file owns only Handmark-specific routing values. The shared DNS, router, TLS, nginx, release,
restart, and rollback procedures live in [`GO-LIVE.md`](../GO-LIVE.md) and
[`SERVER-STANDARD.md`](../SERVER-STANDARD.md). The port and service registries remain
[`PORTS.md`](../PORTS.md) and [`SERVER-INVENTORY.md`](../SERVER-INVENTORY.md); do not copy their
server-wide facts here.

## Handmark values

- Repository: `/Users/cortex/Development/handmark.io`
- Public origins: `https://handmark.io` and `https://www.handmark.io`
- Local upstream: `http://127.0.0.1:3000`
- LaunchDaemon label: `com.handmark.server`
- Health path: `/healthz`
- Canonical application origin: `APP_BASE_URL=https://handmark.io`
- Active nginx file: `/opt/homebrew/etc/nginx/servers/handmark.io.conf`
- Routing contract: HTTPS and nginx for both hostnames; runtime evidence belongs only in the root
  migration ledger

The tracked [`ops/handmark.nginx.conf.example`](ops/handmark.nginx.conf.example) is a pointer to the
shared config ownership, not an installable replacement for the active file. Do not edit unrelated
nginx blocks or interrupt existing services while working on Handmark.

## Runtime contract

The supported service is `com.handmark.server` executing the selected immutable compiled
TypeScript server against SQLite. The historical `node server/index.mjs` command, JSONL writer, and
legacy definition remain recovery and migration evidence only; they are not the target runtime.
The target definition and its definition-only installer are described in [`AGENTS.md`](AGENTS.md).
Source files and tracked definitions never prove live state. Exact selection, installation,
bootstrap, and verification evidence lives only in
[`../WEB-ARCHITECTURE-MIGRATION.md`](../WEB-ARCHITECTURE-MIGRATION.md).

## Verify the route

The active nginx config is:

```text
/opt/homebrew/etc/nginx/servers/handmark.io.conf
```

```bash
curl -I https://handmark.io
curl -I https://www.handmark.io
```

Expected Handmark behavior before login:

```text
HTTP 302
Location: /login
```

The preserved legacy `.env` belongs only to historical MJS recovery input. The compiled target
reads `HANDMARK_PASSWORD` only from the owned mode-`0600` `.env.web` described in
[`docs/application-storage-cutover.md`](docs/application-storage-cutover.md); it never falls back to
legacy `.env`. Do not put the password in launchd, nginx, docs, or tests.
