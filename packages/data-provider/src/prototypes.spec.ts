import {
  costEstimateSchema,
  prototypeCardDataSchema,
  prototypeErrorCodeSchema,
  prototypeJobStatusSchema,
  prototypeReplyRequestSchema,
  prototypeSubmitRequestSchema,
} from './prototypes';
import * as endpoints from './api-endpoints';
import * as dataService from './data-service';
import request from './request';

describe('Prototype public contracts', () => {
  it('exports every durable job status in state-machine order', () => {
    expect(prototypeJobStatusSchema.options).toEqual([
      'queued',
      'preparing',
      'running',
      'waiting_for_input',
      'review',
      'waiting_for_credentials',
      'waiting_for_funds',
      'completed',
      'failed',
      'canceled',
    ]);
  });

  it('rejects unknown reply payload fields', () => {
    expect(() =>
      prototypeReplyRequestSchema.parse({
        messageId: 'm1',
        prototypeReplyToMessageId: 'p1',
        extra: true,
      }),
    ).toThrow();
  });

  it('validates an ordinary-chat Prototype submit without accepting attachments', () => {
    expect(prototypeSubmitRequestSchema.parse({
      messageId: 'm1', parentMessageId: 'p1', text: 'Build a dashboard',
      modelId: 'openai/gpt-5', endpoint: 'openAI', title: 'Dashboard', revision: 3,
    })).toMatchObject({ revision: 3, endpoint: 'openAI' });
    expect(() => prototypeSubmitRequestSchema.parse({
      messageId: 'm1', parentMessageId: 'p1', text: 'Build a dashboard',
      modelId: 'openai/gpt-5', attachments: [{ fileId: 'f1' }],
    })).toThrow();
    expect(() => prototypeSubmitRequestSchema.parse({
      messageId: 'm1', parentMessageId: 'p1', text: 'Reply text',
      modelId: 'openai/gpt-5', promptMessageId: 'prototype_prompt_1',
    })).toThrow();
  });

  it('accepts only the documented cost estimate shape', () => {
    const estimate = {
      currency: 'USD',
      low: 0.1,
      likely: 0.2,
      high: 0.4,
      recoveryBufferPercent: 20,
      method: 'historical_quantiles',
      sampleSize: 30,
      modelId: 'openai/gpt-5-codex',
      calculatedAt: new Date('2026-09-08T00:00:00.000Z'),
      balanceRemaining: null,
    };

    expect(costEstimateSchema.parse(estimate)).toEqual(estimate);
    expect(() => costEstimateSchema.parse({ ...estimate, recoveryBufferPercent: 10 })).toThrow();
    expect(() => costEstimateSchema.parse({ ...estimate, extra: true })).toThrow();
  });

  it('keeps card payloads free of artifact URLs and other unknown fields', () => {
    expect(() =>
      prototypeCardDataSchema.parse({
        type: 'prototype',
        jobId: 'job_1',
        status: 'running',
        phase: 'Building',
        modelId: 'openai/gpt-5-codex',
        modelWarning: null,
        prototypeName: null,
        previewAvailable: false,
        sourcesAvailable: false,
        canCancel: true,
        canReply: false,
        estimatedCost: null,
        actualCostUsd: 0,
        previewUrl: 'https://internal.invalid',
      }),
    ).toThrow();
  });

  it('exports the complete stable BFF error taxonomy', () => {
    expect(prototypeErrorCodeSchema.options).toEqual([
      'PROTOTYPE_JOB_NOT_FOUND',
      'PROTOTYPE_ACTIVE_JOB_EXISTS',
      'PROTOTYPE_INVALID_STATE',
      'PROTOTYPE_STALE_REVISION',
      'PROTOTYPE_INVALID_REPLY',
      'PROTOTYPE_INVALID_REQUEST',
      'PROTOTYPE_ATTACHMENT_INVALID',
      'PROTOTYPE_REQUIREMENTS_TOO_LARGE',
      'PROTOTYPE_CONTENT_BLOCKED',
      'PROTOTYPE_MODERATION_UNAVAILABLE',
      'PROTOTYPE_MODEL_UNSUPPORTED',
      'PROTOTYPE_MODEL_BLOCKED',
      'PROTOTYPE_ARTIFACT_NOT_READY',
      'PROTOTYPE_STORAGE_UNAVAILABLE',
      'PROTOTYPE_QUEUE_UNAVAILABLE',
      'PROTOTYPE_SERVICE_UNAVAILABLE',
      'PROTOTYPE_SERVICE_TIMEOUT',
      'PROTOTYPE_CANCELED',
      'PROTOTYPE_FAILED',
    ]);
  });

  it('builds only the documented public BFF routes', () => {
    expect(endpoints.prototypeById('job_1')).toBe('/api/prototypes/job_1');
    expect(endpoints.prototypeReply('job_1')).toBe('/api/prototypes/job_1/replies');
    expect(endpoints.prototypeCancel('job_1')).toBe('/api/prototypes/job_1/cancel');
    expect(endpoints.prototypeResume('job_1')).toBe('/api/prototypes/job_1/resume');
    expect(endpoints.prototypeApprove('job_1')).toBe('/api/prototypes/job_1/approve');
    expect(endpoints.prototypeRetry('job_1')).toBe('/api/prototypes/job_1/retry');
    expect(endpoints.prototypeFinalize('job_1')).toBe('/api/prototypes/job_1/finalize');
    expect(endpoints.prototypeHtml('job_1')).toBe('/api/prototypes/job_1/html');
    expect(endpoints.prototypeHtmlDownload('job_1')).toBe('/api/prototypes/job_1/html-download');
    expect(endpoints.prototypeSources('job_1')).toBe('/api/prototypes/job_1/sources');
    expect(endpoints.conversationPrototype('conversation_1')).toBe(
      '/api/conversations/conversation_1/prototype',
    );
    expect(endpoints.conversationPrototypeEvents('conversation_1')).toBe(
      '/api/conversations/conversation_1/prototype/events',
    );
  });

  it('sends every prototype mutation with its idempotency key', () => {
    const post = jest.spyOn(request, 'post').mockResolvedValue({});
    const payload = { messageId: 'message_1', prototypeReplyToMessageId: 'prompt_1' };

    dataService.replyToPrototype('job_1', 'conversation_1', payload, 'reply-key', 4);
    dataService.cancelPrototype('job_1', 'conversation_1', 'cancel-key', 4);
    dataService.resumePrototype('job_1', 'conversation_1', 'resume-key', 4);

    expect(post).toHaveBeenNthCalledWith(1, '/api/prototypes/job_1/replies', payload, {
      headers: {
        'Idempotency-Key': 'reply-key',
        'X-Prototype-Conversation-Id': 'conversation_1',
        'X-Prototype-Revision': '4',
      },
    });
    expect(post).toHaveBeenNthCalledWith(2, '/api/prototypes/job_1/cancel', {}, {
      headers: {
        'Idempotency-Key': 'cancel-key',
        'X-Prototype-Conversation-Id': 'conversation_1',
        'X-Prototype-Revision': '4',
      },
    });
    expect(post).toHaveBeenNthCalledWith(3, '/api/prototypes/job_1/resume', {}, {
      headers: {
        'Idempotency-Key': 'resume-key',
        'X-Prototype-Conversation-Id': 'conversation_1',
        'X-Prototype-Revision': '4',
      },
    });
  });

  it('reads preview and downloads through the authenticated request client', () => {
    const getResponse = jest.spyOn(request, 'getResponse').mockResolvedValue({});

    dataService.getPrototypeHtml('job_1', 'conversation 1');
    dataService.getPrototypeHtmlDownload('job_1', 'conversation 1', 3);
    dataService.getPrototypeSources('job_1', 'conversation 1', 3);

    expect(getResponse).toHaveBeenNthCalledWith(
      1,
      '/api/prototypes/job_1/html?conversationId=conversation+1',
      { responseType: 'blob' },
    );
    expect(getResponse).toHaveBeenNthCalledWith(
      2,
      '/api/prototypes/job_1/html-download?conversationId=conversation+1&version=3',
      { responseType: 'blob' },
    );
    expect(getResponse).toHaveBeenNthCalledWith(
      3,
      '/api/prototypes/job_1/sources?conversationId=conversation+1&version=3',
      { responseType: 'blob' },
    );
  });
});
