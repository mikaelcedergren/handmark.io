# Handmark.io — Agent Entry Point

## North Star!

Handmark is a proof-of-concept public sales site and application flow for a selective trust mark: verification that work was made by a human.

The brand idea is not "anti-tooling" for its own sake. Handmark validates human authorship, human effort, and human care. A person must still be responsible for the meaningful decisions behind the work. No one should receive the mark unless they prove, to a satisfactory standard, that the work is human-made and has no substantial AI replacing the authorship.

The public page should feel like the front door of a coherent company, not a demo. It must sell the concept clearly: human stuff for humans, backed by rigorous review.

## Current Product Shape

- One password-protected proof of concept.
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

Production-like local run:

```bash
PORT=3000 HOST=127.0.0.1 HANDMARK_PASSWORD='replace-with-a-strong-password' SESSION_SECRET='change-me-to-a-long-secret' pnpm start
```

Keep `HOST=127.0.0.1` unless there is a deliberate reason to expose the Node app directly. Public traffic should reach nginx first.

## Hosting And Domain Reality

This computer runs several higher-priority services. Handmark is low priority. Do not interrupt existing servers.

The intended path is:

```text
GoDaddy DNS -> this computer's public IP -> router -> nginx -> 127.0.0.1:3000
```

Current local routing notes are in `DOMAIN_SETUP.md`.

Important constraints:

- Do not destroy, replace, or disrupt `localgate.io`.
- Do not stop nginx unless the user explicitly asks and understands the impact.
- If nginx changes are needed, add or edit only the Handmark server block, validate with nginx's config test, then reload. Prefer reload over restart.
- The active nginx include model on this computer uses `/opt/homebrew/etc/nginx/servers/`.
- Handmark's nginx target should remain `127.0.0.1:3000`.
- GitHub stores code; GitHub does not point the domain to this local Node API.

When giving DNS instructions, verify the current public IP and DNS state first. Public IPs can change. `DOMAIN_SETUP.md` records the latest known setup, not an eternal truth.

## Data, Secrets, And Git Hygiene

- Secrets belong in `.env`, never in committed files.
- `.env.example` documents expected environment keys.
- `data/applications.jsonl` is generated local intake data. Do not commit it.
- `test-results/` is generated. Do not commit it.
- Do not collect raw card details in this app. Add Stripe Checkout or another payment provider before real billing.
- The intended payment model is a `$99` review fee first, then `$79/mo` only after approval.
- Git is read-only by default. Do not stage, commit, push, reset, checkout, merge, rebase, or stash unless the user explicitly asks.

## Design Standard

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

## Design-System Lessons From Neighboring Repos

Useful conventions were derived from:

- `/Users/cortex/Development/cortex/AGENTS.md`
- `/Users/cortex/Development/cortex/framework/README.md`
- `/Users/cortex/Development/easm/asm-frontend/sol-playground/README.md`
- `/Users/cortex/Development/easm/asm-frontend/sol-playground/docs/playground-workflow.md`
- `/Users/cortex/Development/easm/asm-frontend/sol-playground/docs/lab-component-guide.md`
- `/Users/cortex/Development/easm/asm-frontend/sol-playground/docs/design-rules.md`

Apply the relevant principles here:

- Tokens carry intent, not accidental color matches. Use surface, ink, muted, accent, success, danger, etc. because they mean something.
- Discipline is freeing. Let the system make the boring decisions so attention goes to perception and conversion.
- Fix the core pattern, not the symptom. If a layout or component shape is wrong in multiple places, improve the shared CSS pattern instead of patching individual sections.
- Components and sections should behave like sealed pieces. Avoid consumer-side overrides, deep hacks, and local specificity fights.
- The page is the product spec. If a visual or copy choice does not support the trust-mark concept, it probably does not belong.
- When a feature reaches for a reusable UI pattern, create a coherent local section/component style rather than bolting ad hoc declarations onto individual elements.

If user-facing UX or copy work needs a stronger rule source, consult the compiled UX foundation rules referenced by Cortex:

```text
/Users/cortex/Development/ux-foundation/.ai/compiled/
```

Read those files only; do not edit that repo.

## Key Files

- `server/index.mjs` — Express server, login/session handling, protected routes, application API.
- `src/app/app.component.html` — protected sales page template.
- `src/app/app.component.ts` — menu and application submission behavior.
- `public/login.html` — password gate.
- `public/styles.css` — full visual system for the page and login screen.
- `public/assets/handmark-logo.svg` — nav/login mark.
- `public/assets/handmark-symbol.svg` — light-background symbol.
- `public/assets/handmark-stamp.svg` — circular verification stamp.
- `public/assets/handmark-seal.svg` — compact seal for buyer-facing proof examples.
- `public/assets/handmark-og.png` — real 1200x630 OpenGraph image. Regenerate it after major brand/layout changes.
- `tests/e2e/handmark.spec.cjs` — Playwright verification.
- `ops/handmark.nginx.conf.example` — nginx virtual host example.
- `DOMAIN_SETUP.md` — local DNS/nginx/router setup notes.

## Application Flow Notes

The application form asks for the applicant, contact preference, brand/work name, kind of work, public URL, craft summary, proof links, and optional walkthrough preference. `src/app/app.component.ts` fills a few backend defaults for the proof of concept:

- `billingCycle` defaults to `monthly`
- `paymentPreference` defaults to `after-approval`

The applicant must provide `contactPreference`, `brand`, and `category`. Direct contact is part of approval, so do not remove the contact field unless the review process changes. `walkthroughPreference` is optional but should be saved when present.

If you change the form, keep `src/app/app.component.*`, `server/index.mjs`, and `tests/e2e/handmark.spec.cjs` aligned. The server still validates required fields before writing an application.

## Verification

Use Playwright for UI verification. Do not claim a visual change is verified unless you actually ran it or explicitly say you could not.

Run the local Playwright script after starting the server with a known test password:

```bash
HANDMARK_TEST_PASSWORD=handmark-dev-password pnpm e2e
```

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

## Local Service Checks

Useful checks:

```bash
curl -s -I http://127.0.0.1:3000/
curl -s -I -H 'Host: handmark.io' http://127.0.0.1/
curl -s -I -H 'Host: localgate.io' http://127.0.0.1/
```

Expected Handmark behavior before login:

```text
HTTP 302
Location: /login
```

Expected localgate behavior is separate from Handmark. Do not "fix" localgate while working on Handmark unless the user specifically asks.

## Implementation Preferences

- Keep this repo aligned with the shared Angular/Cortex-framework/server standard. Do not add one-off runtime patterns.
- Prefer small, direct Node and static-file changes.
- Keep edits scoped to Handmark files.
- Keep comments sparse and useful.
- Use ASCII by default.
- Keep `SESSION_SECRET` mandatory for `NODE_ENV=production`; the development default is local-only.
- When changing the UI, update tests if the public contract changed.
- When changing domain/server setup, update `DOMAIN_SETUP.md`.

## Product Copy Guidance

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
