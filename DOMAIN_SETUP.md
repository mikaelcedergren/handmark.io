# Handmark.io domain setup

This file owns only Handmark-specific routing values. Shared DNS, router, TLS, nginx, release,
restart, and rollback procedures live in [`GO-LIVE.md`](../GO-LIVE.md) and
[`SERVER-STANDARD.md`](../SERVER-STANDARD.md).

## Handmark values

- Repository: `/Users/cortex/Development/handmark.io`
- Public origins: `https://handmark.io` and `https://www.handmark.io`
- Local upstream: `http://127.0.0.1:3000`
- LaunchDaemon: `com.handmark.server`
- Health path: `/healthz`
- Canonical origin: `APP_BASE_URL=https://handmark.io`
- Active nginx file: `/opt/homebrew/etc/nginx/servers/handmark.io.conf`

The tracked [`ops/handmark.nginx.conf.example`](ops/handmark.nginx.conf.example) records only
Handmark-specific values and shared ownership. It is not an installable replacement for the active
nginx file.

## Verification

```bash
curl -I https://handmark.io
curl -I https://www.handmark.io
```

Before login, both hosts should respond with:

```text
HTTP 302
Location: /login
```

The compiled service reads authentication secrets only from the owned mode-`0600` `.env.web`.
Never place passwords or session secrets in launchd, nginx, documentation, tests, or Git.
