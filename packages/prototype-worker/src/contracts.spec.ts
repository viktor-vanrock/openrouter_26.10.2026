import { parsePrototypeCommand, parsePrototypeWorkerEvent } from './contracts';

const command = {
  schemaVersion: 1,
  commandId: 'command_1',
  kind: 'start_turn',
  jobId: 'job_abc',
  turnId: 'turn_1',
  tenantId: 'tenant_1',
  modelId: 'openai/gpt-5-codex',
  expectedRevision: 0,
  executionId: 'execution_1',
  checkpointRevision: null,
  attachmentManifest: [],
  createdAt: '2026-09-10T12:00:00.000Z',
};

const event = {
  schemaVersion: 1,
  eventId: 'event_1',
  commandId: 'command_1',
  jobId: 'job_abc',
  turnId: 'turn_1',
  executionId: 'execution_1',
  expectedRevision: 0,
  leaseId: 'lease_1',
  type: 'progress',
  payload: { phase: 'generation' },
  createdAt: '2026-09-10T12:00:00.000Z',
};

describe('prototype worker contracts', () => {
  it('parses strict versioned command and event envelopes', () => {
    expect(parsePrototypeCommand(command)).toEqual(command);
    expect(parsePrototypeWorkerEvent(event)).toEqual(event);
  });

  it.each([
    { ...command, schemaVersion: 2 },
    { ...command, createdAt: 'yesterday' },
    { ...command, credential: 'secret' },
    { ...command, commandId: 'x'.repeat(257) },
    { ...command, expectedRevision: -1 },
  ])('rejects an unsafe command envelope', (value) => {
    expect(() => parsePrototypeCommand(value)).toThrow();
  });

  it.each([
    { ...event, schemaVersion: 2 },
    { ...event, type: 'unknown' },
    { ...event, createdAt: 'not-iso' },
    { ...event, token: 'secret' },
    { ...event, leaseId: '' },
    { ...event, payload: { nested: { authorization: 'Bearer secret' } } },
    { ...event, payload: { workspacePath: '/tmp/job' } },
  ])('rejects an unsafe event envelope', (value) => {
    expect(() => parsePrototypeWorkerEvent(value)).toThrow();
  });

  it('rejects unsafe job, execution, and attachment identities', () => {
    expect(() => parsePrototypeCommand({ ...command, jobId: '../escape' })).toThrow();
    expect(() => parsePrototypeCommand({ ...command, executionId: 'execution/1' })).toThrow();
    expect(() => parsePrototypeCommand({
      ...command,
      attachmentManifest: [{ fileId: 'file/1', filename: 'a.txt', mimeType: 'text/plain', size: 1 }],
    })).toThrow();
  });

  it.each([
    { ...event, type: 'completed', payload: { prototypeSlug: 'crm', summary: 'Done' } },
    { ...event, type: 'usage', payload: { costUsd: 0, inputTokens: 10, outputTokens: 4 } },
    { ...event, type: 'credentials_required', payload: { checkpointRevision: 2 } },
    { ...event, type: 'funds_required', payload: {} },
    {
      schemaVersion: 1,
      eventId: 'event_gateway_1',
      jobId: 'job_abc',
      executionId: 'execution_1',
      expectedRevision: 0,
      leaseId: 'lease_1',
      type: 'credentials_required',
      payload: {},
      createdAt: '2026-09-10T12:00:00.000Z',
    },
  ])('parses a typed result payload', (value) => {
    expect(parsePrototypeWorkerEvent(value)).toEqual(value);
  });

  it.each([
    { ...event, type: 'waiting', payload: {} },
    { ...event, type: 'review_ready', payload: { summary: 'ready' } },
    { ...event, type: 'completed', payload: { summary: 'done' } },
    { ...event, type: 'progress', payload: {} },
    { ...event, type: 'progress', payload: { phase: '' } },
    { ...event, type: 'usage', payload: { inputTokens: 1, outputTokens: 2 } },
    { ...event, type: 'usage', payload: { costUsd: -1 } },
    { ...event, type: 'usage', payload: { costUsd: 1, inputTokens: -1 } },
    { ...event, type: 'failed', payload: { code: 'RAW_PROVIDER_ERROR' } },
    { ...event, type: 'credentials_required', payload: { checkpointRevision: -1 } },
    { ...event, commandId: undefined, type: 'progress', payload: { phase: 'generation' } },
  ])('rejects an event whose payload does not match its type', (value) => {
    expect(() => parsePrototypeWorkerEvent(value)).toThrow();
  });
});
