# Handmark.io — Agent Entry Point

## North star!

Handmark is a protected early product and application flow for a selective trust mark: verification that work was made by a human.

The brand idea is not "anti-tooling" for its own sake. Handmark validates human authorship, human effort, and human care. A person must still be responsible for the meaningful decisions behind the work. No one should receive the mark unless they prove, to a satisfactory standard, that the work is human-made and has no substantial AI replacing the authorship.

The public page should feel like the front door of a coherent company, not a demo. It must sell the concept clearly: human stuff for humans, backed by rigorous review.

## Current product shape

- One password-protected early product.
- One public sales page after login.
- One initial review path: `$99` human review, followed by `$79/mo` membership only if approved.
- One application flow, stored locally.
- No self-serve stamp issuance. Submitted proof starts the review, but it does not replace direct contact.
- Handmark contacts the applicant and asks them to walk through the process, digitally or in person, before approval.
- If approved, the verification membership continues at `$79/mo`. If not approved, no subscription starts and no stamp is issued.
- No tiers. The applicant either proves the human-made claim and uses the mark, or they do not.

## Runtime

This repo now follows the shared Mac mini website standard.

- App entry: `server/index.mjs`
- Angular source: `src/`
- Static public assets and login page: `public/`
- Application data: `data/applications.jsonl`
- Default local server: `http://127.0.0.1:3000`
- Password is read from `HANDMARK_PASSWORD` in `.env`; do not place it in launchd or docs.

Run locally:

```bash
pnpm start
```

Publish production content with:

```bash
node ../server-ops/bin/site-release.mjs --site handmark --apply
```

The shared release behavior and rollback procedure are owned by the root
[`SERVER-STANDARD.md`](../SERVER-STANDARD.md).

Production-like local run:

```bash
PORT=3000 HOST=127.0.0.1 HANDMARK_PASSWORD='replace-with-a-strong-password' SESSION_SECRET='replace-with-at-least-32-random-characters' pnpm start
```

Keep `HOST=127.0.0.1` unless there is a deliberate reason to expose the Node app directly. Public traffic should reach nginx first.

## Hosting and domain reality

Handmark is live on HTTPS at `handmark.io` via the shared static-IP nginx path. The path itself
(static IP, router forwarding, nginx as the only public gateway, the nginx include model) is owned
by the root docs — see the root `AGENTS.md` ("Static IP state") and `GO-LIVE.md`. What is
handmark-specific: daemon `com.handmark.server` serves the app locally at `127.0.0.1:3000`, and
repo routing values are in `DOMAIN_SETUP.md`. Do not interrupt existing servers.

Important constraints:

- Do not destroy, replace, or disrupt `localgate.io`.
- Do not stop nginx unless the user explicitly asks and understands the impact.
- If nginx changes are needed, add or edit only the Handmark server block, validate with nginx's config test, then reload. Prefer reload over restart.
- Handmark's nginx target should remain `127.0.0.1:3000`.
- GitHub stores code; GitHub does not point the domain to this local Node API.

## Data, secrets, and git hygiene

- Secrets belong in `.env`, never in committed files.
- `.env.example` documents expected environment keys.
- `data/applications.jsonl` is generated local intake data. Do not commit it.
- Application storage is intentionally bounded: records expire at 90 days, and the file has hard
  ceilings of 100 MiB and 10,000 records. `server/application-store.mjs` owns serialized appends,
  atomic retention compaction, drain-aware shutdown, 24-hour stale compaction-temp cleanup, and
  clear capacity/integrity failures. The main store must remain a single-link regular file. Temp
  cleanup matches only the store's exact generated filename shape and never follows symlinks. Do not
  bypass the store with direct file appends.
- Login/application abuse tracking is owned by `server/request-limiter.mjs`. Its expiring
  client/scope buckets cap at 10,000 and fail closed when every live slot is occupied; do not add
  an uncapped request-state map in `server/index.mjs`.
- `test-results/` is generated. Do not commit it.
- Do not collect raw card details in this app. Add Stripe Checkout or another payment provider before real billing.
- The intended payment model is a `$99` review fee first, then `$79/mo` only after approval.
- Git is read-only by default. Do not stage, commit, push, reset, checkout, merge, rebase, or stash unless the user explicitly asks.

## Design standard

Treat this as a professional public sales page for a company with a thought-through concept. The UI bar is high.

The page should be:

- Minimal, deliberate, and premium.
- Night-mode first.
- Human and relatable without becoming sentimental.
- Conversion-focused without feeling like a generic SaaS page.
- CTA-light: one clear primary action in the hero, then the final form submit. Pricing facts and review requirements should read as supporting information, not extra buttons.
- Legible at every viewport, with controlled max widths and no full-screen line lengths.
- Responsive, including a working mobile hamburger and clear mobile conversion path.
- Coherent as a package: logo, stamp, proof-page mockup, copy, pricing, application, and review standard should all reinforce the same trust product.

Avoid:

- Generic checklist-heavy marketing.
- Placeholder-looking mockups.
- One-off visual hacks.
- Huge full-width cards or paragraphs.
- Incoherent nested cards.
- Quirks, novelty styling, or copy that sounds like an internal demo.

The current logo/stamp assets in `public/assets/` are SVG interpretations of the provided handmark direction. They can be refined, but keep the identity centered on the hand/stamp idea: made by human hands.

## Framework integrity

Cortex is the source of truth; `cx-framework` is its packaged contract; Handmark is only a consumer.
The package comes from GitHub `main`; local styles may compose tokens but never redefine framework
behaviour.

- Never modify, reference, fork, or optimise Cortex or `cx-framework` from this repository.
- Consumers adapt forward. Never preserve an old contract with compatibility layers, aliases,
  wrappers, redirects, overrides, or temporary framework hacks.
- If the framework is missing something, document it under **🚨 Cortex Action Required** and stop;
  never recreate it locally.
- Prefer simpler architecture and deletion over preserving behaviour. Keep one implementation and
  remove verified dead, duplicate, obsolete, compatibility, legacy, and deprecated code.
- Evidence beats assumptions: uncertain removals are reported, not guessed.
- Add a shared abstraction only when it clearly simplifies today's system. Optimise for five-year
  maintainability, not today's convenience.
- Tokens carry intent. Components and sections stay sealed; no deep overrides or specificity fights.
- The page is the product spec: anything that does not support the trust-mark concept does not belong.

## Key files

- `server/index.mjs` — Express server, login/session handling, protected routes, application API.
- `src/app/app.component.html` — protected sales page template.
- `src/app/app.component.ts` — menu and application submission behavior.
- `public/login.html` — password gate.
- `src/styles/site.scss` — global stylesheet entry; pulls in the cx-framework tokens, base, self-hosted fonts, and utilities, then the page composition. Compiled by Angular into a stable `/styles.css` (angular.json `styles`, `inject: false`) that both the app and the static login page link.
- `src/styles/_page.scss` — Handmark page/login composition; arranges framework tokens and utilities only, defines no local design values.
- `public/assets/fonts/` — framework woff2 files served from this origin for the framework `@font-face` rules.
- `public/assets/handmark-logo.svg` — nav/login mark.
- `public/assets/handmark-symbol.svg` — light-background symbol.
- `public/assets/handmark-stamp.svg` — circular verification stamp.
- `public/assets/handmark-seal.svg` — compact seal for buyer-facing proof examples.
- `public/assets/handmark-og.png` — real 1200x630 OpenGraph image. Regenerate it after major brand/layout changes.
- `tests/e2e/handmark.spec.cjs` — Playwright verification.
- `ops/handmark.nginx.conf.example` — nginx virtual host example.
- `DOMAIN_SETUP.md` — local DNS/nginx/router setup notes.

## Application flow notes

The application form asks for the applicant, contact preference, brand/work name, kind of work, public URL, craft summary, proof links, and optional walkthrough preference. `src/app/app.component.ts` fills a few backend defaults for the early product:

- `billingCycle` defaults to `monthly`
- `paymentPreference` defaults to `after-approval`

The applicant must provide `contactPreference`, `brand`, and `category`. Direct contact is part of approval, so do not remove the contact field unless the review process changes. `walkthroughPreference` is optional but should be saved when present.

If you change the form, keep `src/app/app.component.*`, `server/index.mjs`, and `tests/e2e/handmark.spec.cjs` aligned. The server still validates required fields before writing an application.

## Verification

Use Playwright for UI verification. Do not claim a visual change is verified unless you actually ran it or explicitly say you could not.

Run the isolated Playwright script:

```bash
pnpm e2e
```

The Playwright config builds and serves on reserved port `4231`, uses an explicit local build path,
and writes applications to a temporary test-only directory. The suite refuses the production port
and production `data/` directory.

The test covers:

- Login wall.
- Night-mode background.
- SEO metadata.
- Hero and proof-page sales flow.
- One membership only.
- Review fee and approval-gated subscription copy.
- Layout width constraints.
- Application submission.
- Mobile hamburger.
- `robots.txt` and `sitemap.xml`.

Screenshots are written to:

```text
/private/tmp/handmark-login.png
/private/tmp/handmark-desktop.png
/private/tmp/handmark-mobile.png
```

## Local service checks

The canonical health check is `/healthz` and returns a JSON health payload:

```bash
curl -s http://127.0.0.1:3000/healthz
```

Useful checks:

```bash
curl -s -I http://127.0.0.1:3000/
curl -s -I -H 'Host: handmark.io' http://127.0.0.1/
curl -s -I -H 'Host: localgate.io' http://127.0.0.1/
```

Expected Handmark behavior before login (app-level check):

```text
HTTP 302
Location: /login
```

Expected localgate behavior is separate from Handmark. Do not "fix" localgate while working on Handmark unless the user specifically asks.

## Implementation preferences

- Keep this repo aligned with the shared Angular/Cortex-framework/server standard. Do not add one-off runtime patterns.
- Prefer small, direct Node and static-file changes.
- Keep edits scoped to Handmark files.
- Keep comments sparse and useful.
- Use ASCII by default.
- Keep `SESSION_SECRET` at least 32 characters and `HANDMARK_PASSWORD` at least 12 characters when
  `NODE_ENV=production`; the development defaults are local-only.
- When changing the UI, update tests if the public contract changed.
- When changing domain/server setup, update `DOMAIN_SETUP.md`.

## Product copy guidance

Handmark should sound calm, serious, and human.

Use language around:

- human authorship
- human care
- effort
- craft
- proof
- review
- responsibility
- no proof, no stamp

Avoid language that makes Handmark sound like:

- a decorative badge marketplace
- an anti-AI manifesto
- a luxury gimmick
- a generic SaaS subscription
- an automated certification engine

The strongest positioning is:

```text
A public trust mark for work made by a person.
```

Everything else should support that sentence.
