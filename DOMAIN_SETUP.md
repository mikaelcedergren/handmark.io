# Handmark.io domain setup

This file records the Handmark-specific routing values. The shared go-live procedure (DNS, router, nginx, certbot) lives in the root docs — see [`../GO-LIVE.md`](../GO-LIVE.md) and [`../SERVER-STANDARD.md`](../SERVER-STANDARD.md). Do not stop nginx, the existing Node services, or anything else already listening on a port.

Current Handmark setup, updated after static-IP HTTPS go-live:

- Repo: `/Users/cortex/Development/handmark.io`
- Local app: `http://127.0.0.1:3000`
- Public front door: nginx on ports `80` and `443`
- Routing model: GoDaddy DNS -> `81.170.132.41` -> router TCP 80/443 -> nginx -> `127.0.0.1:3000`
- Current LAN IP for this computer: `192.168.1.73`
- Router/default gateway: `192.168.1.1`
- Public domains: `https://handmark.io`, `https://www.handmark.io`
- Service (daemon): `com.handmark.server`
- Health endpoint: `/healthz` (back-compat alias `/api/health`)
- HTTPS: live through nginx; certificate renewal is handled by `com.cortex.cert-renewal`
- Status: live HTTPS on `handmark.io` and `www.handmark.io`

Current DNS state:

- `handmark.io` uses GoDaddy/domaincontrol nameservers.
- `@` is an `A` record pointing to `81.170.132.41`.
- `www` is a `CNAME` pointing to `handmark.io`.
- Keep unrelated mail records if they are added later.
- Cloudflared is not used; keep this domain on the direct static-IP nginx path.

## Go-live procedure

The generic DNS, router, nginx, and certbot steps are owned by the root docs — see [`../GO-LIVE.md`](../GO-LIVE.md) and [`../SERVER-STANDARD.md`](../SERVER-STANDARD.md). Do not duplicate them here. Only the Handmark-specific values below apply on top of that procedure.

## Handmark-specific nginx

The active nginx config is:

```text
/opt/homebrew/etc/nginx/servers/handmark.io.conf
```

It keeps ACME open on HTTP, redirects normal HTTP to HTTPS, terminates TLS on port `443`, and proxies only to `127.0.0.1:3000`. Do not edit unrelated server blocks.

## Verify

```bash
curl -I https://handmark.io
curl -I https://www.handmark.io
```

Expected result before login:

```text
HTTP 302
Location: /login
```

Use the password configured in `.env` as `HANDMARK_PASSWORD`. Do not put the password in launchd, nginx, docs, or tests.
