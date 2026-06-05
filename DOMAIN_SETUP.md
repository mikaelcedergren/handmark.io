# Handmark.io Domain Setup

This guide keeps the existing servers on this computer as the priority. Do not stop nginx, Plex, the existing Node services, or anything else already listening on a port.

Current Handmark setup:

- Repo: `/Users/cortex/Development/handmark.io`
- Local app: `http://127.0.0.1:3000`
- Public front door already in use: nginx on port `80`
- Preferred routing model: GoDaddy DNS -> this computer's public IP -> router -> nginx -> Handmark app
- Current public IPv4 seen from this computer: `155.4.129.219`
- Current LAN IP for this computer: `192.168.1.74`
- Router/default gateway: `192.168.1.1`

Current DNS state:

- `handmark.io` uses GoDaddy nameservers: `ns01.domaincontrol.com`, `ns02.domaincontrol.com`
- `handmark.io` currently points to GoDaddy parked-site IPs: `13.248.243.5`, `76.223.105.230`
- `www.handmark.io` is already a CNAME to `handmark.io`
- `localgate.io` uses Cloudflare nameservers: `annalise.ns.cloudflare.com`, `trevor.ns.cloudflare.com`
- `localgate.io` is Cloudflare-fronted through a Cloudflare Tunnel, then nginx routes it to `127.0.0.1:8080`
- `jordan.localgate.io` is Cloudflare-fronted and nginx routes it to `127.0.0.1:4010`

## 1. Keep Handmark on a local-only port

Start Handmark on localhost only:

```bash
npm start
```

The server defaults to:

```text
HOST=127.0.0.1
PORT=3000
```

This means the app does not compete with nginx on port `80` and is not directly exposed to the public internet.

## 2. Add an nginx virtual host

Use the example in `ops/handmark.nginx.conf.example`.

Active nginx path on this computer:

```text
/opt/homebrew/etc/nginx/nginx.conf
```

That file includes:

```nginx
include servers/*;
```

So the Handmark config should be added as:

```text
/opt/homebrew/etc/nginx/servers/handmark.io.conf
```

The important part is:

```nginx
server {
  listen 80;
  server_name handmark.io www.handmark.io;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Add this as a new nginx site or server block. Do not edit unrelated server blocks.

After adding it, validate nginx before reloading:

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
| A | @ | `155.4.129.219` | 600 seconds or GoDaddy default |
| CNAME | www | `handmark.io` | 600 seconds or GoDaddy default |

Notes:

- Keep email records such as `MX`, `TXT`, `SPF`, `DKIM`, and `DMARC`.
- Remove the existing GoDaddy parked-site `A` records for `@`: `13.248.243.5` and `76.223.105.230`.
- Keep the existing `www` CNAME if it already points to `handmark.io`.
- A `CNAME` points to another name, not an IP address.
- Keep the nameservers as GoDaddy's current nameservers: `ns01.domaincontrol.com`, `ns02.domaincontrol.com`.

GoDaddy references:

- https://www.godaddy.com/help/add-or-edit-an-a-record-42546
- https://www.godaddy.com/help/manage-dns-records-680

## 4. Point the router at this computer

On the router, forward:

| Public port | Protocol | Destination |
| --- | --- | --- |
| 80 | TCP | `192.168.1.74` |
| 443 | TCP | `192.168.1.74` |

Make this computer's LAN IP stable with a DHCP reservation so the router does not start forwarding to the wrong machine later.

## 5. Add HTTPS

After DNS reaches nginx and port `80` works, add a TLS certificate for:

```text
handmark.io
www.handmark.io
```

Use the certificate method that already fits this computer's nginx setup. Certbot with nginx is the common path. Do not install a second front-facing proxy on ports `80` or `443` unless you intentionally replace the existing nginx setup.

## 6. Verify

From any machine:

```bash
curl -I http://handmark.io
curl -I http://www.handmark.io
```

Expected result before login:

```text
HTTP 302
Location: /login
```

Then open:

```text
http://handmark.io
```

Use the proof-of-concept password:

```text
Wolfentastic-1
```

## 7. GitHub

GitHub does not point the domain to this computer. GitHub stores the code.

Use GitHub like this:

1. Push this repo to `mikaelcedergren/handmark.io`.
2. Pull updates on this computer.
3. Restart only the Handmark app process when the app changes.

Do not configure GitHub Pages for this proof of concept unless you decide to move away from the local Node server. GitHub Pages cannot run this local application API or save applications to `data/applications.jsonl`.
