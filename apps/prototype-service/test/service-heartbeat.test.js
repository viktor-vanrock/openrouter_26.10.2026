import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startServiceHeartbeat } from '../src/service-heartbeat.js';

test('heartbeats follow readiness and tolerate an unavailable API independently of worker turns', async () => {
  let ready = false;
  let posts = 0;
  const stop = startServiceHeartbeat({
    intervalMs: 5,
    isReady: async () => ready,
    client: {
      post: async () => {
        posts++;
        throw new Error('API offline');
      },
    },
  });
  try {
    await delay(15);
    assert.equal(posts, 0);
    ready = true;
    await delay(15);
    assert.ok(posts > 0);
    stop();
    const count = posts;
    await delay(15);
    assert.equal(posts, count);
  } finally {
    stop();
  }
});

test('heartbeat logs the first failure and recovery, without flooding successful or repeated failed probes', async () => {
  const events = [];
  let failed = true;
  let posts = 0;
  const stop = startServiceHeartbeat({
    intervalMs: 5,
    isReady: async () => true,
    log: (event, fields) => events.push({ event, ...fields }),
    client: {
      post: async () => {
        posts++;
        if (failed) throw Object.assign(new Error('private-dependency-error'), { status: 503 });
      },
    },
  });
  try {
    await delay(25);
    assert.ok(posts > 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'heartbeat.failed');
    assert.equal(events[0].httpStatus, 503);
    failed = false;
    await delay(25);
    assert.equal(events.length, 2);
    assert.equal(events[1].event, 'heartbeat.available');
    assert.ok(events[1].failureCount > 1);
    assert.doesNotMatch(JSON.stringify(events), /private-dependency-error/);
  } finally {
    stop();
  }
});
