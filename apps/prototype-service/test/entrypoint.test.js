import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('production entrypoint reports missing env field without echoing secrets or loading root dotenv', () => {
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../src/entrypoint.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        PROTOTYPE_SERVICE_TOKEN: 'must-not-leak',
      },
      timeout: 5000,
    },
  );
  assert.equal(child.status, 1);
  const entry = JSON.parse(child.stdout.trim());
  assert.equal(entry.service, 'prototype-worker');
  assert.equal(entry.event, 'service.startup_failed');
  assert.equal(entry.code, 'PROTOTYPE_CONFIG_INVALID');
  assert.match(entry.diagnostics.join(''), /PROTOTYPE_SERVICE_ROLE/);
  assert.doesNotMatch(child.stdout + child.stderr, /must-not-leak/);
});
