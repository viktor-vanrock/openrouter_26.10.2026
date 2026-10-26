import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const launcher = 'apps/prototype-service/src/gateway-agent-launch.mjs';
test('fixed agent launcher rejects arbitrary script, shell and extra arguments before sandbox work', () => {
  for (const args of [['/tmp/untrusted.mjs'], ['sh'], ['runtime-probe', '--allow-bash'], []]) {
    const r = spawnSync(process.execPath, [launcher, ...args], {
      encoding: 'utf8',
      timeout: 2000,
      env: { PATH: process.env.PATH, PROTOTYPE_SERVICE_TOKEN: 'must-not-appear' },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /AGENT_DISPATCH_DENIED/);
    assert.doesNotMatch(r.stdout + r.stderr, /must-not-appear/);
  }
});
