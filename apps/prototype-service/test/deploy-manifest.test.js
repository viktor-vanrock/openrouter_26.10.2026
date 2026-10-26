import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = fs.readFileSync(path.join(root, 'deploy/base.yaml'), 'utf8');

test('base deployment fails closed until cluster enforcement is operator-attested', () => {
  assert.match(manifest, /networkPolicyEnforced: "false"/);
  assert.match(manifest, /admissionPolicyEnforced: "false"/);
  assert.match(manifest, /pidLimitEnforced: "false"/);
});

test('scheduler RBAC and admission do not allow broad sandbox mutation', () => {
  assert.match(manifest, /resources: \["jobs"\]/);
  assert.doesNotMatch(manifest, /verbs: \["\*"\]/);
  assert.match(manifest, /kind: ValidatingAdmissionPolicy/);
  assert.match(manifest, /automountServiceAccountToken == false/);
  assert.match(manifest, /!has\(v\.hostPath\)/);
  assert.match(manifest, /@sha256:/);
  assert.match(manifest, /dependency-gateway-proxy-only-placeholder/);
  assert.match(manifest, /BLOCKED_BY_ENVIRONMENT/);
});
