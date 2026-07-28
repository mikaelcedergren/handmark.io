import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBrowserServing } from '../../../server-ops/lib/site-server.mjs';
import {
  BUILD_ID_PLACEHOLDER,
  publishSiteRelease,
  releasePaths,
} from '../../../server-ops/lib/site-release.mjs';

test('named files and static lookup share one release while the active link switches', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'handmark-browser-serving-'));
  t.after(() => fs.rmSync(repoRoot, { force: true, recursive: true }));

  publishRelease(repoRoot, 'release-one', 'first');

  const staticRoots = [];
  const expressStub = {
    static(root) {
      staticRoots.push(root);
      return (_req, _res, next) => next();
    },
  };
  const serving = createBrowserServing({
    express: expressStub,
    repoRoot,
    legacyBrowserDir: path.join(repoRoot, 'dist', 'browser'),
  });
  const staticMiddleware = serving.staticMiddleware();
  const request = {};

  staticMiddleware(request, {}, () => {});
  const firstSnapshot = serving.browserDirForRequest(request);
  assert.equal(fs.readFileSync(path.join(firstSnapshot, 'release.txt'), 'utf8'), 'first');
  assert.equal(staticRoots[0], firstSnapshot);

  publishRelease(repoRoot, 'release-two', 'second');

  assert.equal(serving.browserDirForRequest(request), firstSnapshot);
  assert.equal(fs.readFileSync(path.join(firstSnapshot, 'release.txt'), 'utf8'), 'first');

  const nextRequest = {};
  staticMiddleware(nextRequest, {}, () => {});
  const secondSnapshot = serving.browserDirForRequest(nextRequest);
  assert.equal(fs.readFileSync(path.join(secondSnapshot, 'release.txt'), 'utf8'), 'second');
  assert.equal(staticRoots[1], secondSnapshot);
  assert.notEqual(secondSnapshot, firstSnapshot);
});

function publishRelease(repoRoot, releaseId, marker) {
  const browserDir = releasePaths(repoRoot, releaseId).stagedBrowser;
  fs.mkdirSync(browserDir, { recursive: true });
  fs.writeFileSync(
    path.join(browserDir, 'index.html'),
    `<meta name="cx-build-id" content="${BUILD_ID_PLACEHOLDER}">`,
  );
  fs.writeFileSync(
    path.join(browserDir, 'main-ABCDEFGH.js'),
    `export const release = '${marker}';`,
  );
  fs.writeFileSync(path.join(browserDir, 'release.txt'), marker);
  publishSiteRelease({
    repoRoot,
    releaseId,
    revision: 'a'.repeat(40),
    sourceFingerprint: 'b'.repeat(64),
    sourceDirty: true,
  });
}
