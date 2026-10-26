import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('yaml');
const root = path.resolve(import.meta.dirname, '..', '..', '..');
const documentPath = path.join(import.meta.dirname, 'bff-openapi.yaml');
const modelProxyPath = path.join(import.meta.dirname, 'model-proxy-openapi.yaml');
const routePath = path.join(root, 'api/server/routes/prototypes.js');
const modelProxyRoutePath = path.join(root, 'api/server/routes/internal/prototypeModelProxy.js');

const document = yaml.parse(fs.readFileSync(documentPath, 'utf8'));
const modelProxyDocument = yaml.parse(fs.readFileSync(modelProxyPath, 'utf8'));
if (document?.openapi !== '3.1.0' || !document.paths || !document.components?.schemas) {
  throw new Error('Prototype BFF OpenAPI document is incomplete');
}
if (
  modelProxyDocument?.openapi !== '3.1.0' ||
  !modelProxyDocument.paths ||
  !modelProxyDocument.components?.securitySchemes?.jobToken
) {
  throw new Error('Prototype Model Proxy OpenAPI document is incomplete');
}

for (const [name, schema] of Object.entries(document.components.schemas)) {
  if (typeof schema !== 'object' || schema == null || ('$ref' in schema && !schema.$ref)) {
    throw new Error(`Invalid component schema: ${name}`);
  }
  if ('type' in schema && !['object', 'string', 'number', 'integer', 'boolean', 'array'].includes(schema.type)) {
    throw new Error(`Invalid component schema type: ${name}.${schema.type}`);
  }
}

const expected = new Set([
  'GET /api/prototypes/{jobId}',
  'POST /api/prototypes/{jobId}/replies',
  'POST /api/prototypes/{jobId}/cancel',
  'POST /api/prototypes/{jobId}/resume',
  'POST /api/prototypes/{jobId}/approve',
  'POST /api/prototypes/{jobId}/retry',
  'POST /api/prototypes/{jobId}/finalize',
  'GET /api/prototypes/{jobId}/html',
  'GET /api/prototypes/{jobId}/html-download',
  'GET /api/prototypes/{jobId}/sources',
  'GET /api/conversations/{conversationId}/prototype',
  'POST /api/conversations/{conversationId}/prototype',
  'GET /api/conversations/{conversationId}/prototype/events',
]);
const actual = new Set();
const operationIds = new Set();
for (const [route, item] of Object.entries(document.paths)) {
  for (const method of Object.keys(item)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
      actual.add(`${method.toUpperCase()} ${route}`);
      const operation = item[method];
      if (!operation.operationId || operationIds.has(operation.operationId)) {
        throw new Error(`Missing or duplicate operationId at ${method.toUpperCase()} ${route}`);
      }
      operationIds.add(operation.operationId);
      if (!operation.responses || !Object.keys(operation.responses).some((code) => code.startsWith('2'))) {
        throw new Error(`Operation has no success response: ${method.toUpperCase()} ${route}`);
      }
    }
  }
}
if (expected.size !== actual.size || [...expected].some((entry) => !actual.has(entry))) {
  throw new Error(`BFF path/method set mismatch: ${JSON.stringify([...actual].sort())}`);
}

const source = fs.readFileSync(routePath, 'utf8');
for (const marker of ["'/:jobId'", "'/:jobId/replies'", "'/:conversationId/prototype'"]) {
  if (!source.includes(marker)) throw new Error(`Express route marker missing: ${marker}`);
}
for (const forbidden of ['Worker', 'Redis', 'PVC', 'Model Proxy']) {
  if (fs.readFileSync(documentPath, 'utf8').includes(forbidden)) {
    throw new Error(`Internal implementation leaked into public contract: ${forbidden}`);
  }
}

const declaredCodes = new Set(document.components.schemas.ErrorCode.enum);
const expectedCodes = new Set([
  'PROTOTYPE_JOB_NOT_FOUND', 'PROTOTYPE_ACTIVE_JOB_EXISTS', 'PROTOTYPE_INVALID_STATE',
  'PROTOTYPE_STALE_REVISION', 'PROTOTYPE_INVALID_REPLY', 'PROTOTYPE_INVALID_REQUEST',
  'PROTOTYPE_ATTACHMENT_INVALID', 'PROTOTYPE_REQUIREMENTS_TOO_LARGE',
  'PROTOTYPE_CONTENT_BLOCKED', 'PROTOTYPE_MODERATION_UNAVAILABLE',
  'PROTOTYPE_MODEL_UNSUPPORTED', 'PROTOTYPE_MODEL_BLOCKED', 'PROTOTYPE_ARTIFACT_NOT_READY',
  'PROTOTYPE_STORAGE_UNAVAILABLE', 'PROTOTYPE_QUEUE_UNAVAILABLE',
  'PROTOTYPE_SERVICE_UNAVAILABLE', 'PROTOTYPE_SERVICE_TIMEOUT', 'PROTOTYPE_CANCELED',
  'PROTOTYPE_FAILED',
]);
if (declaredCodes.size !== expectedCodes.size || [...expectedCodes].some((code) => !declaredCodes.has(code))) {
  throw new Error('Stable error code set mismatch');
}

const proxyActual = new Set();
for (const [route, item] of Object.entries(modelProxyDocument.paths)) {
  for (const method of Object.keys(item)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
      proxyActual.add(`${method.toUpperCase()} ${route}`);
      const operation = item[method];
      if (!operation.operationId || !operation.responses?.['200']) {
        throw new Error(`Model Proxy operation is incomplete: ${method.toUpperCase()} ${route}`);
      }
    }
  }
}
if (
  proxyActual.size !== 1 ||
  !proxyActual.has('POST /internal/prototype-model/v1/chat/completions')
) {
  throw new Error(`Model Proxy path/method set mismatch: ${JSON.stringify([...proxyActual].sort())}`);
}
const proxyResponseCodes = new Set(
  Object.keys(modelProxyDocument.paths['/internal/prototype-model/v1/chat/completions'].post.responses),
);
const expectedProxyResponseCodes = new Set(['200', '401', '402', '413', '422', '429', '503']);
if (
  proxyResponseCodes.size !== expectedProxyResponseCodes.size ||
  [...expectedProxyResponseCodes].some((code) => !proxyResponseCodes.has(code))
) {
  throw new Error(`Model Proxy response set mismatch: ${JSON.stringify([...proxyResponseCodes].sort())}`);
}
const proxySource = fs.readFileSync(modelProxyRoutePath, 'utf8');
if (!proxySource.includes("router.post('/chat/completions'")) {
  throw new Error('Express Model Proxy route marker missing');
}
const proxyRaw = fs.readFileSync(modelProxyPath, 'utf8');
for (const marker of [
  'Bearer job token',
  'forced',
  '16 KiB',
  'text/event-stream',
  'caller-supplied target URLs or headers',
]) {
  if (!proxyRaw.includes(marker)) throw new Error(`Model Proxy contract marker missing: ${marker}`);
}

console.log(
  `Prototype OpenAPI contracts are valid (${actual.size} BFF operations, 1 Model Proxy operation).`,
);
