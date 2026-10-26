import assert from 'node:assert/strict';
import test from 'node:test';
import { reactAgentRulesBundle } from '../src/react-agent-instructions.js';

test('rules bundle is deterministic, versioned, self contained and puts the bounded Gateway override last', async () => {
  const first = await reactAgentRulesBundle();
  const second = await reactAgentRulesBundle();
  assert.equal(first.digest, second.digest);
  assert.equal(first.manifest.version, 'gateway-fsd-v1');
  assert.equal(first.manifest.files.at(-1).path, 'rules/gateway-fsd.md');
  assert.match(first.instructions, /Only trusted checks and owner\/fence\/revision CAS/);
  const changed = await reactAgentRulesBundle({
    read: async (url) => `${url.pathname}\nchanged reference`,
  });
  assert.notEqual(first.digest, changed.digest);
});
