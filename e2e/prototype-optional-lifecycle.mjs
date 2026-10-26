/** T037: real API replicas, isolated startup faults, accepted OBS reads and UI cancel during outage.
 * No provider calls. Only this runner's users/fixture/processes are removed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { chromium, expect } from '@playwright/test';
import { createPrototypeStoreModels } from '@librechat/data-schemas';
dotenv.config({ quiet: true });
const api = process.env.DOMAIN_SERVER || 'http://localhost:3080';
const ui = 'http://localhost:5173';
const out = path.resolve(`.prototype-dev/optional-lifecycle-${Date.now()}`);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const evidence = { at: new Date().toISOString(), checks: {}, replicas: {},
  browser: 'Playwright; Browser plugin not available', providerRequests: 0 };
const scope = new mongoose.Mongoose();
let models, browser, page, ownedUser, token, cancelJob, cancelConversation, workerStopped = false;
const children = new Set();
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function poll(check, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* bounded startup/recovery */ }
    await delay(500);
  }
  throw new Error('Acceptance condition timed out');
}
async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) { children.delete(child); return; }
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(10_000)]);
  if (child.exitCode == null && child.signalCode == null) { child.kill('SIGKILL'); await exited; }
  children.delete(child);
}
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function startApi(label, preload) {
  const port = await freePort();
  const logfile = await fs.open(`${out}/${label}.log`, 'w', 0o600);
  const child = spawn(process.execPath, [...(preload ? ['--require', preload] : []), 'api/server/index.js'], {
    env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port),
      PROTOTYPE_EVENT_CONSUMER: `acceptance-${randomUUID()}`, PROTOTYPE_OUTBOX_PUBLISHER: `acceptance-${randomUUID()}` },
    stdio: ['ignore', logfile.fd, logfile.fd],
  });
  children.add(child); await logfile.close();
  const url = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  await poll(async () => (await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2000) })).ok);
  evidence.replicas[label] = { readinessMs: Date.now() - startedAt, ready: true };
  if (!preload && process.env.PROTOTYPE_MODEL_PROXY_ENABLED === 'true') {
    await poll(async () => (await fetch(`${url}/api/prototype-model/v1/models`, { signal: AbortSignal.timeout(2000) })).status === 401);
    evidence.checks.scopedAdapterStartedWithoutBlockingOrdinaryApi = true;
  }
  return { child, url };
}
async function request(base, route, options = {}) {
  return fetch(`${base}${route}`, { ...options, signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers } });
}
async function restartWorker() {
  if (!workerStopped) return;
  const logfile = await fs.open(`${out}/worker-recovery.log`, 'w', 0o600);
  const child = spawn('npm', ['run', 'prototype:dev'], { detached: true, stdio: ['ignore', logfile.fd, logfile.fd] });
  await logfile.close(); child.unref();
  await poll(async () => (await (await request(api, '/api/prototypes/availability')).json()).available === true);
  workerStopped = false;
}
try {
  assert.match(process.env.PROTOTYPE_ACCEPTANCE_JOB_ID || '', /^job_[a-f0-9]{24}$/);
  assert.match(process.env.PROTOTYPE_ACCEPTANCE_OWNED_TEST_USER_ID || '', /^[a-f0-9]{24}$/);
  assert.match(process.env.PROTOTYPE_ACCEPTANCE_OWNER_ID || '', /^[a-f0-9]{24}$/);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 2000 });
  await scope.connect(process.env.PROTOTYPE_MONGO_URI, { serverSelectionTimeoutMS: 2000 });
  models = createPrototypeStoreModels(scope);
  const accepted = await models.PrototypeJob.findOne({ jobId: process.env.PROTOTYPE_ACCEPTANCE_JOB_ID }).lean();
  assert.equal(accepted?.status, 'completed');
  assert.equal(String(accepted.userId), process.env.PROTOTYPE_ACCEPTANCE_OWNED_TEST_USER_ID);
  assert.equal(await mongoose.connection.db.collection('users').countDocuments({ _id: accepted.userId }), 0,
    'Only a removed, explicitly identified own acceptance account can be restored');
  const email = `prototype-lifecycle-${randomUUID()}@example.invalid`;
  const password = randomBytes(24).toString('hex');
  await mongoose.connection.db.collection('users').insertOne({ _id: accepted.userId, email, username: email,
    name: 'Optional lifecycle acceptance', password: await bcrypt.hash(password, 10),
    provider: 'local', role: 'USER', emailVerified: true });
  ownedUser = { _id: accepted.userId, email };
  const keys = await mongoose.connection.db.collection('keys').find({ name: 'OpenRouter',
    userId: new mongoose.Types.ObjectId(process.env.PROTOTYPE_ACCEPTANCE_OWNER_ID) }).limit(2).toArray();
  assert.equal(keys.length, 1);
  const { _id, ...key } = keys[0];
  await mongoose.connection.db.collection('keys').insertOne({ ...key, userId: ownedUser._id });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${ui}/login`);
  await page.getByLabel('Email').fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  const loggedIn = page.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
  await page.getByTestId('login-button').click();
  token = (await (await loggedIn).json()).token; assert.ok(token);
  await page.waitForURL(/\/c\/new/);
  await page.waitForTimeout(3000);
  const close = page.getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible()) await close.click();
  await poll(async () => (await (await request(api, '/api/prototypes/availability')).json()).available === true);
  evidence.checks.login = true;

  // Full second API, same store/Redis, no direct worker heartbeats sent to this replica.
  const second = await startApi('second-api');
  await poll(async () => (await (await request(second.url, '/api/prototypes/availability')).json()).available === true);
  evidence.checks.multiApiHeartbeat = true;
  assert.equal((await request(second.url, '/api/prototypes/availability', { headers: { authorization: 'Bearer invalid' } })).status, 401);
  evidence.checks.unauthenticatedCapabilityDenied = true;
  await stopChild(second.child);

  // Faults apply only to a new child. Never corrupt the real worker's runtime profile.
  const malformed = `${out}/malformed-runtime.json`;
  await fs.writeFile(malformed, '{invalid-json', { mode: 0o600 });
  const preload = `${out}/startup-fault.cjs`;
  await fs.writeFile(preload, `
const path = require('node:path');
const profile = require(path.resolve('api/server/services/Prototypes/PrototypeDevProfile.js'));
const original = profile.applyPrototypeDevProfile;
profile.applyPrototypeDevProfile = options => original({ ...options, filename: ${JSON.stringify(malformed)} });
const transport = require(path.resolve('api/server/services/Prototypes/PrototypeTransportStartup.js'));
transport.startPrototypeTransport = () => new Promise(() => {});
`, { mode: 0o600 });
  const fault = await startApi('hung-prototype-malformed-profile', preload);
  const faultConfig = await request(fault.url, '/api/config'); assert.equal(faultConfig.status, 200);
  assert.equal((await (await request(fault.url, '/api/prototypes/availability')).json()).available, false);
  const faultLogin = await fetch(`${fault.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15_000) });
  assert.equal(faultLogin.status, 200);
  const faultLog = await fs.readFile(`${out}/hung-prototype-malformed-profile.log`, 'utf8');
  assert.match(faultLog, /Local prototype profile unavailable/);
  evidence.checks.hungStartupDoesNotBlockReadyConfigLogin = true;
  evidence.checks.malformedProfileIsolated = true;
  await stopChild(fault.child);

  execFileSync(process.execPath, ['apps/prototype-service/scripts/stop-dev.mjs'], { stdio: 'pipe' });
  workerStopped = true;
  await poll(async () => (await (await request(api, '/api/prototypes/availability')).json()).available === false, 25_000);
  const admission = await request(api, '/api/conversations/late-outage/prototype', { method: 'POST', body: '{}' });
  assert.equal(admission.status, 503);
  assert.equal((await admission.json()).error.code, 'PROTOTYPE_SERVICE_UNAVAILABLE');
  evidence.checks.outageRejectsAdmission = true;
  assert.equal((await request(api, '/readyz')).status, 200);
  evidence.checks.ordinaryApiReadyDuringOutage = true;
  await page.goto(`${ui}/c/${accepted.conversationId}`);
  const card = page.getByRole('region', { name: 'Prototype task' });
  await expect(card).toContainText('завершён');
  if (await close.isVisible()) await close.click();
  await card.getByRole('button', { name: 'Открыть предпросмотр' }).click();
  await expect(page.frameLocator('iframe[title="Accepted prototype"]').locator('body')).toContainText(/сотрудник/i);
  const downloads = {};
  for (const [label, filename, expected] of [['HTML', 'prototype.html', accepted.previewDigest],
    ['Исходники', 'sources.zip', accepted.sourcesDigest]]) {
    const waiting = page.waitForEvent('download');
    await card.getByRole('button', { name: label, exact: true }).click();
    await (await waiting).saveAs(`${out}/${filename}`);
    const digest = hash(await fs.readFile(`${out}/${filename}`)); assert.equal(digest, expected);
    downloads[filename] = digest;
  }
  evidence.checks.acceptedPreviewAndDownloadsDuringOutage = true; evidence.downloads = downloads;
  const wrongBinding = await request(api, `/api/prototypes/${accepted.jobId}?conversationId=foreign-conversation`);
  assert.equal(wrongBinding.status, 404); evidence.checks.wrongConversationDenied = true;
  await page.screenshot({ path: `${out}/accepted-during-outage.png` });

  // Explicit no-execution waiting fixture exercises real cancel transaction/UI without a paid plan.
  cancelConversation = randomUUID(); const suffix = new mongoose.Types.ObjectId().toString();
  cancelJob = `job_${suffix}`;
  const turnId = `turn_${suffix}`, messageId = `message_${suffix}`, promptId = `prompt_${suffix}`;
  const binding = { user: String(ownedUser._id), tenantId: '__default__', conversationId: cancelConversation };
  await mongoose.connection.db.collection('conversations').insertOne({ ...binding, title: 'Outage cancel acceptance',
    endpoint: 'OpenRouter', model: accepted.modelId, createdAt: new Date(), updatedAt: new Date() });
  await mongoose.connection.db.collection('messages').insertMany([
    { ...binding, messageId, text: 'Outage cancel fixture', sender: 'User', isCreatedByUser: true,
      metadata: { prototypeAgent: true }, parentMessageId: 'root', createdAt: new Date() },
    { ...binding, messageId: promptId, text: 'Waiting fixture; no model was called.', sender: 'Prototype', isCreatedByUser: false,
      metadata: { prototypeAgent: true }, parentMessageId: messageId, createdAt: new Date() },
  ]);
  await models.PrototypeJob.create({ jobId: cancelJob, userId: ownedUser._id, tenantId: '__default__', conversationId: cancelConversation,
    originMessageId: messageId, originToolCallId: `fixture:${suffix}`, modelId: accepted.modelId,
    modelPolicyVersion: accepted.modelPolicyVersion, modelRecommendation: accepted.modelRecommendation,
    status: 'waiting_for_input', waitingReason: 'plan_approval', revision: 3, fenceToken: 2,
    activeTurnId: turnId, latestPromptMessageId: promptId });
  await models.PrototypeTurn.create({ jobId: cancelJob, turnId, ordinal: 0, kind: 'initial',
    text: 'Outage cancel fixture', modelId: accepted.modelId, commandId: `fixture_${suffix}`, status: 'applied' });
  const stale = await request(api, `/api/prototypes/${cancelJob}/cancel`, { method: 'POST', body: '{}',
    headers: { 'X-Prototype-Conversation-Id': cancelConversation, 'X-Prototype-Revision': '2', 'Idempotency-Key': `stale:${suffix}` } });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'PROTOTYPE_STALE_REVISION');
  assert.equal((await models.PrototypeJob.findOne({ jobId: cancelJob }).lean()).status, 'waiting_for_input');
  evidence.checks.staleCancelDenied = true;
  await page.goto(`${ui}/c/${cancelConversation}`);
  await card.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(card).toContainText('отменён');
  const canceled = await models.PrototypeJob.findOne({ jobId: cancelJob }).lean();
  assert.equal(canceled.status, 'canceled'); assert.equal(canceled.fenceToken, 3);
  assert.equal(await models.PrototypeOutbox.countDocuments({ jobId: cancelJob, kind: 'cancel_execution' }), 1);
  evidence.checks.uiCancelDuringOutage = true;
  evidence.cancelScope = 'waiting fixture; durable cancellation and fence, no active sandbox stop attestation';
  await page.screenshot({ path: `${out}/canceled-during-outage.png` });
  await restartWorker(); evidence.checks.workerRecovered = true;
  assert.deepEqual(errors, []); evidence.pageErrors = errors;
  evidence.passed = true;
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${out}/failure.png` }).catch(() => undefined);
    await fs.writeFile(`${out}/failure.txt`, await page.locator('body').innerText(), { mode: 0o600 }).catch(() => undefined);
  }
  evidence.passed = false; evidence.failure = { name: error.name, message: error.message.split('\n')[0] };
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) await stopChild(child);
  try { await restartWorker(); } catch { evidence.workerRecoveryFailed = true; process.exitCode = 1; }
  if (cancelJob && models) {
    for (const name of ['PrototypeJob', 'PrototypeTurn', 'PrototypeEvent', 'PrototypeOutbox']) {
      await models[name].deleteMany({ jobId: cancelJob });
    }
  }
  if (cancelConversation && mongoose.connection.readyState === 1) {
    for (const name of ['messages', 'conversations', 'prototypechatbindings']) await mongoose.connection.db.collection(name).deleteMany({ conversationId: cancelConversation });
  }
  if (ownedUser && mongoose.connection.readyState === 1) {
    for (const name of ['sessions', 'tokens', 'keys']) await mongoose.connection.db.collection(name).deleteMany({ userId: ownedUser._id });
    await mongoose.connection.db.collection('users').deleteOne(ownedUser);
  }
  await scope.disconnect(); await mongoose.disconnect();
  await fs.writeFile(`${out}/receipt.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ ...evidence, evidenceDirectory: out }));
