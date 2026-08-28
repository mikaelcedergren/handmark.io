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
- Public status: HTTPS live for both hostnames

The tracked [`ops/handmark.nginx.conf.example`](ops/handmark.nginx.conf.example) is a pointer to the
shared config ownership, not an installable replacement for the active file. Do not edit unrelated
nginx blocks or interrupt existing services while working on Handmark.

## Runtime selection

The live daemon still runs the legacy `node server/index.mjs` command and JSONL intake. The compiled
TypeScript/SQLite server is source-complete but remains unselected until the separately authorised
procedure in
[`docs/application-storage-cutover.md`](docs/application-storage-cutover.md) passes. A source build
does not change this operational state.

## Verify the current route

The active nginx config is:

```text
/opt/homebrew/etc/nginx/servers/handmark.io.conf
```

```bash
curl -I https://handmark.io
curl -I https://www.handmark.io
```

Expected result before login:

```text
HTTP 302
Location: /login
```

The still-selected legacy MJS daemon reads `HANDMARK_PASSWORD` from `.env`. The compiled target will
read it only from the owned mode-`0600` `.env.web` described in
[`docs/application-storage-cutover.md`](docs/application-storage-cutover.md); it never falls back to
legacy `.env`. Do not put the password in launchd, nginx, docs, or tests.
