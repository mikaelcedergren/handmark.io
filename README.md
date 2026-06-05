# Handmark.io

Handmark is a proof-of-concept review and subscription site for verifying work that is actually crafted by a human.

## What is included

- Password gate using `Wolfentastic-1` by default.
- Protected one-page sales site.
- Pricing and human-review application flow.
- Local application storage in `data/applications.jsonl`.
- No external runtime dependencies.

## Review and pricing model

- The initial human review currently costs `$99`.
- Submitted proof is only the starting point. Handmark contacts the applicant directly and asks them to walk through the process before approval.
- The application form asks for applicant identity, contact preference, work category, proof links, and optional walkthrough preference because direct contact is part of the review.
- If the applicant is approved, the verification membership continues at `$79/mo`.
- If the applicant is not approved, no subscription starts and no stamp is issued.

## Run locally

```bash
npm start
```

Open `http://localhost:3000` and enter the password.

For a production-like local run:

```bash
PORT=3000 HOST=127.0.0.1 HANDMARK_PASSWORD='Wolfentastic-1' SESSION_SECRET='change-me-to-a-long-secret' npm start
```

If `NODE_ENV=production`, `SESSION_SECRET` must be set. The server refuses to start with the development default.

## Domain setup with GoDaddy

GitHub stores the code, but DNS should point to the computer that is running the server.
This computer already has nginx listening on port `80`, so Handmark should stay on `127.0.0.1:3000` and nginx should proxy only `handmark.io` traffic to it.

The full low-risk guide is in `DOMAIN_SETUP.md`.

Short version:

1. Point GoDaddy DNS `@` to your public IP address.
2. Point GoDaddy DNS `www` to `@` with a CNAME.
3. Add an nginx virtual host for `handmark.io` that proxies to `127.0.0.1:3000`.
4. Forward router ports `80` and `443` to this computer.
5. Add HTTPS after the domain reaches nginx.

## GitHub setup

After the first commit, push the repo:

```bash
git add .
git commit -m "Build Handmark proof of concept"
git push -u origin main
```

On the server computer, keep this checkout updated with `git pull`, then restart the app.

## Real payment next step

The current form records an application and selected review path. To charge the review fee or subscription, add Stripe Checkout or another payment provider. Do not collect raw card details in this app.
