import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelineClient } from '../src/pipeline-client.js';

test('a failed execution returns the actual bounded compiler diagnostics', async () => {
  const client = new PipelineClient({ baseUrl: 'https://localhost:19443' });
  client.request = async (method, route) => {
    if (method === 'POST') return { name: 'run-test' };
    if (route.endsWith('/diagnostics'))
      return {
        code: 'PROTOTYPE_BUILD_FAILED',
        diagnostics: [
          'type-check: src/app/App.tsx(296,10): error TS2322: rightIcon is incompatible',
        ],
      };
    return { status: 'failed' };
  };
  await assert.rejects(
    client.run({
      executionId: 'repro',
      profile: 'offline-react-build-v1',
      format: 'react',
      source: 'source',
    }),
    (error) => error.writersStopped === true && error.diagnostics?.[0].includes('TS2322'),
  );
});
