# Handmark.io

Handmark is a protected early review and subscription product for verifying work that is actually crafted by a human.

## What is included

- Password gate backed by `HANDMARK_PASSWORD` in `.env`.
- Angular sales site served by the standard local Express server.
- Pricing and human-review application flow.
- Local application storage in `data/applications.jsonl`.
- Bounded application storage: records expire after at most 90 days, with hard ceilings of 100 MiB
  and 10,000 records. Retention rewrites are atomic; a full or unhealthy store rejects intake
  clearly without overwriting the existing file. Shutdown drains in-flight maintenance, and exact
  compaction temp files left by an interrupted process are removed once older than 24 hours.
- Bounded abuse tracking: login/application rate-limit state expires on schedule, caps at 10,000
  client/scope buckets, and fails closed for new clients at capacity.
- Runtime secrets are read from `.env`; launchd only stores non-secret process settings.

## Review and pricing model

- The initial human review currently costs `$99`.
- Submitted proof is only the starting point. Handmark contacts the applicant directly and asks them to walk through the process before approval.
- The application form asks for applicant identity, contact preference, work category, proof links, and optional walkthrough preference because direct contact is part of the review.
- If the applicant is approved, the verification membership continues at `$79/mo`.
- If the applicant is not approved, no subscription starts and no stamp is issued.

## Run locally

```bash
pnpm start
```

Open `http://127.0.0.1:3000` and enter the password.

For a production-like local run:

```bash
PORT=3000 HOST=127.0.0.1 HANDMARK_PASSWORD='replace-with-a-strong-password' SESSION_SECRET='replace-with-at-least-32-random-characters' pnpm start
```

If `NODE_ENV=production`, `SESSION_SECRET` must contain at least 32 characters and
`HANDMARK_PASSWORD` at least 12. The server refuses to start with weak or missing values.

## Domain and hosting

Handmark is live on HTTPS at `handmark.io` via the shared static-IP nginx path (`DNS -> 81.170.132.41 -> router 80/443 -> nginx -> 127.0.0.1:3000`). Repo-specific routing values are in [`DOMAIN_SETUP.md`](DOMAIN_SETUP.md); the shared go-live procedure is in the root [`GO-LIVE.md`](../GO-LIVE.md).

## Real payment next step

The current form records an application and selected review path. To charge the review fee or subscription, add Stripe Checkout or another payment provider. Do not collect raw card details in this app.

## Build and verify

```bash
pnpm install
pnpm build
pnpm e2e
```

Publish production content with:

```bash
node ../server-ops/bin/site-release.mjs --site handmark --apply
```

The release and rollback contract is documented once in the root
[`SERVER-STANDARD.md`](../SERVER-STANDARD.md). The E2E command is self-contained and isolated from
the production port, build, and application data.

## Server standard

Handmark now follows the shared Mac mini standard: Angular frontend, local Express server, `127.0.0.1:3000`, nginx as the public gateway, `.run/` logs, and a source-controlled launch daemon template in `launchd/com.handmark.server.plist`.
