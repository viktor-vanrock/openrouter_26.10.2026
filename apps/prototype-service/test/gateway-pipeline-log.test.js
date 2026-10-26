import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayPipelineClient } from '../src/gateway-pipeline-client.js';
import { REACT_BUILD_PROFILE } from '../src/pipeline-contract.js';

test('ambiguous Gateway failure logs full command correlation and never retries the create POST', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-log-'));
  const events = [];
  let posts = 0;
  const command = {
    jobId: 'job_1',
    turnId: 'turn_1',
    commandId: 'command_1',
    executionId: 'execution_1',
    attemptId: 'attempt_1',
    modelId: '~openai/gpt-luna-latest',
    stage: 'build_qa',
    expectedRevision: 2,
    fenceToken: 3,
  };
  const pipeline = new GatewayPipelineClient({
    directory,
    image: 'fixture-image',
    log: (event, fields) => events.push({ event, ...fields }),
    gateway: {
      request: async () => {
        posts++;
        throw Object.assign(new Error('private-error https://private.test?token=secret'), {
          status: 503,
        });
      },
    },
  });
  try {
    await assert.rejects(
      pipeline.run(
        {
          executionId: command.executionId,
          profile: REACT_BUILD_PROFILE,
          format: 'react',
          source:
            "import { Button } from '@ai-sber/uikit'; export function App() { return <Button>Demo</Button>; }",
        },
        { command },
      ),
    );
    assert.equal(posts, 1);
    const failure = events.find((entry) => entry.event === 'gateway.failed');
    assert.equal(failure.jobId, command.jobId);
    assert.equal(failure.commandId, command.commandId);
    assert.equal(failure.stage, 'build_qa');
    assert.equal(failure.httpStatus, 503);
    assert.doesNotMatch(JSON.stringify(events), /private-error|private.test|token=secret/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
