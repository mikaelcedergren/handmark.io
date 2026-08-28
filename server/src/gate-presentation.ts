import {
  SITE_GATE_FORM_SLOT,
  createSiteGatePresentation,
} from '@mikaelcedergren/cx-framework/server/gate';

export const HANDMARK_GATE_PRESENTATION = createSiteGatePresentation({
  form: {
    errorClassName: 'login-error cx-text-body-sm',
    errorMessage: 'Incorrect password. Try again.',
    formClassName: 'login-form',
    inputClassName: 'login-input',
    labelClassName: 'login-label',
    passwordLabel: 'Access password',
    submitClassName: 'login-submit',
    submitLabel: 'Enter Handmark',
  },
  template: `<!doctype html>
<html lang="en" class="theme-night">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Handmark access | human-made work verification</title>
    <meta name="description" content="Private access to the Handmark proof of concept for human-made work verification.">
    <meta name="robots" content="noindex, nofollow">
    <meta name="theme-color" content="#000000">
    <link rel="icon" href="/assets/handmark-symbol.svg?v=20260603-2" type="image/svg+xml">
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body class="login-screen">
    <main class="login-shell">
      <section class="login-panel" aria-labelledby="login-title">
        <div class="login-brand">
          <img class="login-mark" src="/assets/handmark-logo.svg?v=20260603-2" alt="">
          <span>handmark</span>
        </div>
        <p class="eyebrow">Private proof of concept</p>
        <h1 id="login-title" class="cx-text-title-1">Human-made work, verified.</h1>
        <p class="login-copy cx-text-body-lg cx-text-muted">A controlled preview of the Handmark trust mark, application flow, and subscriber review standard.</p>
        ${SITE_GATE_FORM_SLOT}
      </section>
      <p class="login-footnote">Handmark.io</p>
    </main>
  </body>
</html>`,
});
