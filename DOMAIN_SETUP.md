# Handmark.io domain setup

This guide keeps the existing servers on this computer as the priority. Do not stop nginx, Plex, the existing Node services, or anything else already listening on a port.

Current Handmark setup, updated after static-IP HTTPS go-live:

- Repo: `/Users/cortex/Development/handmark.io`
- Local app: `http://127.0.0.1:3000`
- Public front door: nginx on ports `80` and `443`
- Routing model: GoDaddy DNS -> `81.170.132.41` -> router TCP 80/443 -> nginx -> `127.0.0.1:3000`
- Current LAN IP for this computer: `192.168.1.73`
- Router/default gateway: `192.168.1.1`
- Public domains: `https://handmark.io`, `https://www.handmark.io`
- Service: `com.handmark.server`
- HTTPS: live through nginx; certificate renewal is handled by `com.cortex.cert-renewal`

Current DNS state:

- `handmark.io` uses GoDaddy/domaincontrol nameservers.
- `@` should be an `A` record pointing to `81.170.132.41`.
- `www` should be a `CNAME` pointing to `handmark.io`.
- Keep unrelated mail records if they are added later.
- Cloudflared is not used; keep this domain on the direct static-IP nginx path.

## 1. Keep Handmark on a local-only port

Start Handmark on localhost only:

```bash
pnpm start
```

The server defaults to:

```text
HOST=127.0.0.1
PORT=3000
```

This means the app does not compete with nginx on port `80` and is not directly exposed to the public internet.

## 2. nginx virtual host

The active nginx config is:

```text
/opt/homebrew/etc/nginx/servers/handmark.io.conf
```

It should keep ACME open on HTTP, redirect normal HTTP traffic to HTTPS, terminate TLS on port `443`, and proxy only to `127.0.0.1:3000`.

Do not edit unrelated server blocks.

After changes, validate nginx before reloading:

```bash
/opt/homebrew/bin/nginx -t
```

Only if the test passes, reload nginx:

```bash
/opt/homebrew/bin/nginx -s reload
```

Reloading is preferred over stopping or restarting because it is lower risk for the existing services.

## 3. GoDaddy DNS

In GoDaddy, open the domain portfolio, select `handmark.io`, then open DNS records.

Set these records:

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| A | @ | `81.170.132.41` | GoDaddy default |
| CNAME | www | `handmark.io` | 600 seconds or GoDaddy default |

Notes:

- Keep email records such as `MX`, `TXT`, `SPF`, `DKIM`, and `DMARC`.
- Remove any GoDaddy parked-site `A` records for `@`, such as `13.248.243.5` and `76.223.105.230`, if they reappear.
- Keep the existing `www` CNAME if it already points to `handmark.io`.
- A `CNAME` points to another name, not an IP address.
- Keep the nameservers as GoDaddy/domaincontrol nameservers unless a deliberate exception is documented.

GoDaddy references:

- https://www.godaddy.com/help/add-or-edit-an-a-record-42546
- https://www.godaddy.com/help/manage-dns-records-680

## 4. Point the router at this computer

On the router, forward:

| Public port | Protocol | Destination |
| --- | --- | --- |
| 80 | TCP | `192.168.1.73` |
| 443 | TCP | `192.168.1.73` |

Make this computer's LAN IP stable with a DHCP reservation so the router does not start forwarding to the wrong machine later.

## 5. Add HTTPS

HTTPS is already live for `handmark.io` and `www.handmark.io`. Renewal is handled by `com.cortex.cert-renewal`.

For future certificate changes, keep using the shared certbot/nginx setup. Do not install a second front-facing proxy on ports `80` or `443` unless you intentionally replace the existing nginx setup.

## 6. Verify

From any machine:

```bash
curl -I https://handmark.io
curl -I https://www.handmark.io
```

Expected result before login:

```text
HTTP 302
Location: /login
```

Then open:

```text
https://handmark.io
```

Use the password configured in `.env` as `HANDMARK_PASSWORD`. Do not put the password in launchd, nginx, docs, or tests.

## 7. GitHub

GitHub does not point the domain to this computer. GitHub stores the code.

Use GitHub like this:

1. Push this repo to `mikaelcedergren/handmark.io`.
2. Pull updates on this computer.
3. Install dependencies only if package files changed.
4. Build if the Angular app changed.
5. Restart only the Handmark app process when the served output or server process changes.
6. Verify local health and public HTTPS.

Do not configure GitHub Pages for this proof of concept unless you decide to move away from the local Node server. GitHub Pages cannot run this local application API or save applications to `data/applications.jsonl`.
