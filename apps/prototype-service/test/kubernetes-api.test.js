import assert from 'node:assert/strict';
import test from 'node:test';
import { KubernetesHttpApi } from '../src/kubernetes-api.js';

test('reads runtime and operator-owned enforcement attestations before readiness', async () => {
  const calls = [];
  const api = new KubernetesHttpApi({
    baseUrl: 'https://kubernetes.test',
    tokenPath: '/unused',
    caPath: '/unused',
    namespace: 'prototype-sandbox',
    capabilitiesConfigMap: 'prototype-capabilities',
    request: async (method, path) => {
      calls.push([method, path]);
      if (path.includes('runtimeclasses')) return { metadata: { name: 'gvisor' } };
      return {
        data: {
          networkPolicyEnforced: 'true',
          admissionPolicyEnforced: 'true',
          pidLimitEnforced: 'true',
        },
      };
    },
  });
  assert.deepEqual(await api.readCapabilities('gvisor'), {
    runtimeClasses: ['gvisor'],
    networkPolicyEnforced: true,
    admissionPolicyEnforced: true,
    pidLimitEnforced: true,
  });
  assert.equal(calls.length, 2);
});

test('scopes create and delete calls to the configured namespace', async () => {
  const calls = [];
  const api = new KubernetesHttpApi({
    baseUrl: 'https://kubernetes.test',
    tokenPath: '/unused',
    caPath: '/unused',
    namespace: 'prototype-sandbox',
    capabilitiesConfigMap: 'prototype-capabilities',
    request: async (...args) => {
      calls.push(args);
      return {};
    },
  });
  await api.createJob({ kind: 'Job' });
  await api.deleteJob({
    namespace: 'prototype-sandbox',
    name: 'prototype-generation-one',
    propagationPolicy: 'Foreground',
    gracePeriodSeconds: 5,
  });
  assert.equal(calls[0][1], '/apis/batch/v1/namespaces/prototype-sandbox/jobs');
  assert.equal(calls[1][0], 'DELETE');
  assert.throws(
    () =>
      api.deleteJob({
        namespace: 'other',
        name: 'prototype-generation-one',
        propagationPolicy: 'Foreground',
        gracePeriodSeconds: 5,
      }),
    /namespace mismatch/,
  );
});
