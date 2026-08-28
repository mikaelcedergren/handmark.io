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
- Public routing status: HTTPS and nginx configured for both hostnames; backend intentionally
  offline at the current migration boundary

The tracked [`ops/handmark.nginx.conf.example`](ops/handmark.nginx.conf.example) is a pointer to the
shared config ownership, not an installable replacement for the active file. Do not edit unrelated
nginx blocks or interrupt existing services while working on Handmark.

## Runtime selection

The authorised 2026-08-28 maintenance boundary unloaded `com.handmark.server`, removed its
conventional installed plist, proved launchctl status `113`, and proved port `3000` closed. The
last runtime used the legacy `node server/index.mjs` command and JSONL intake. The compiled
TypeScript/SQLite server is source-complete but remains unselected until the separately authorised
procedure in [`docs/application-storage-cutover.md`](docs/application-storage-cutover.md) passes.
No data import, registry switch, release selection, or target bootstrap has occurred. A source build
does not change this operational state.

## Verify the route after target bootstrap

The active nginx config is:

```text
/opt/homebrew/etc/nginx/servers/handmark.io.conf
```

```bash
curl -I https://handmark.io
curl -I https://www.handmark.io
```

At the current stopped boundary these requests do not prove an application response because the
registered upstream has no listener. Expected result only after an authorised target bootstrap:

```text
HTTP 302
Location: /login
```

The preserved legacy `.env` belongs only to historical MJS recovery input; no Handmark daemon is
currently loaded. The compiled target reads `HANDMARK_PASSWORD` only from the owned mode-`0600`
`.env.web` described in
[`docs/application-storage-cutover.md`](docs/application-storage-cutover.md); it never falls back to
legacy `.env`. Do not put the password in launchd, nginx, docs, or tests.
