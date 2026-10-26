const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createPrototypeStoreModels, createPrototypeMethods } = require('@librechat/data-schemas');
const { PrototypeService } = require('../../services/Prototypes/PrototypeService');
const { createPrototypeRouters } = require('../prototypes');
const axios = require('axios');
jest.mock('axios');

jest.setTimeout(30000);

let replica;
let scope;
let models;
let app;
const conversationId = '267ce663-344e-4df9-89ae-85d13d9158df';
const userId = new mongoose.Types.ObjectId().toString();
const modelId = '~openai/gpt-luna-latest';
const config = {
  prototypeAgent: {
    enabled: true,
    modelPolicy: {
      version: 'persistence-regression',
      requireToolCalling: false,
      unknownModelPolicy: 'warn',
    },
  },
};
const text =
  'Создай интерактивный прототип небольшого менеджера задач. Список из 5 вымышленных задач: название, исполнитель, статус. Поиск и фильтр по статусу, добавление с обязательным названием, переключение статуса, удаление с подтверждением и отображение на телефоне.';

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  scope = new mongoose.Mongoose();
  await scope.connect(replica.getUri(), { dbName: 'prototype_submit_regression' });
  models = createPrototypeStoreModels(scope);
  await Promise.all(Object.values(models).map((model) => model.init()));
  const methods = createPrototypeMethods(scope);
  const service = new PrototypeService({
    ...methods,
    startSession: () => scope.startSession(),
    getConversation: async () => ({ conversationId }),
    createPrototypeUserMessage: (input, session) =>
      models.Message.create([input], { session }).then(([message]) => message.toObject()),
    findOwnedPrototypeJobByConversation: (input, session) =>
      models.PrototypeJob.findOne(input, null, { session }).lean(),
    createPrototypeTurn: (input, session) =>
      models.PrototypeTurn.create([input], { session }).then(([turn]) => turn.toObject()),
    findPrototypeOutbox: (commandId, session) =>
      models.PrototypeOutbox.findOne({ commandId }, null, { session }).lean(),
    createId: (kind) => `${kind}_${new mongoose.Types.ObjectId()}`,
  });
  const routers = createPrototypeRouters({
    prototypeService: service,
    requireAuth: (req, _res, next) => {
      req.user = { id: userId, tenantId: 'tenant-test' };
      next();
    },
    loadConfig: (req, _res, next) => {
      req.config = config;
      next();
    },
    isAvailable: () => true,
  });
  app = express();
  app.use(express.json());
  app.use('/api/prototypes', routers.jobs);
  app.use('/api/conversations', routers.conversations);
});

afterAll(async () => {
  await scope?.disconnect();
  await replica?.stop();
});

test('available worker accepts a chat submit and atomically persists its current card and outbox', async () => {
  const availability = await request(app).get('/api/prototypes/availability');
  expect(availability.body).toEqual({ available: true });
  const submit = () =>
    request(app)
      .post(`/api/conversations/${conversationId}/prototype`)
      .set('Idempotency-Key', 'chat:message-regression')
      .send({
        messageId: 'message-regression',
        parentMessageId: 'parent-regression',
        text,
        modelId,
      });
  const response = await submit();
  expect(response.status).toBe(201);
  expect(response.body).toMatchObject({ status: 'queued', selectedVariant: null, modelId });
  const event = await models.PrototypeEvent.findOne({ jobId: response.body.jobId }).lean();
  expect(event.publicPayload).toEqual(response.body);
  expect(await models.PrototypeJob.countDocuments()).toBe(1);
  expect(await models.PrototypeTurn.countDocuments()).toBe(1);
  expect(await models.PrototypeOutbox.countDocuments()).toBe(1);
  expect(await models.Message.countDocuments()).toBe(1);
  const repeated = await submit();
  expect(repeated.status).toBe(201);
  expect(repeated.body).toEqual(response.body);
  expect(await models.PrototypeEvent.countDocuments()).toBe(1);
  expect(await models.PrototypeOutbox.countDocuments()).toBe(1);
});

test('content rejection persists no message, turn, job, event or execution command in a real transaction', async () => {
  const previous = process.env.OPENAI_MODERATION;
  process.env.OPENAI_MODERATION = 'true';
  axios.post.mockResolvedValue({ data: { results: [{ flagged: true }] } });
  const names = ['PrototypeJob', 'PrototypeTurn', 'PrototypeOutbox', 'PrototypeEvent', 'Message'];
  const before = await Promise.all(names.map((name) => models[name].countDocuments()));
  try {
    const response = await request(app)
      .post('/api/conversations/rejected-content-fixture/prototype')
      .set('Idempotency-Key', 'chat:rejected-content')
      .send({ messageId: 'rejected-content', parentMessageId: 'parent-content',
        text: 'Blocked content fixture', modelId });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PROTOTYPE_CONTENT_BLOCKED');
    expect(await Promise.all(names.map((name) => models[name].countDocuments()))).toEqual(before);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_MODERATION;
    else process.env.OPENAI_MODERATION = previous;
  }
});

test('moderation and code share the durable turn budget and an unknown moderation request cannot replay', async () => {
  const { reservePersonalModelRequest } = await import(
    require('node:url').pathToFileURL(require('node:path').resolve(__dirname,
      '../../../../apps/prototype-service/src/local-model-budget.js')).href
  );
  const previous = process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD;
  process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD = '1';
  const command = { jobId: 'job_content_budget', turnId: 'turn_content_budget',
    commandId: 'command_content_budget', attemptId: 'attempt_content_budget', executionId: 'execution_content_budget',
    userId, tenantId: 'tenant-test', modelId, expectedRevision: 0, fenceToken: 1,
    stage: 'generation', pipelineStep: 0 };
  try {
    await scope.connection.db.collection('prototypejobs').insertOne({
      jobId: command.jobId, userId: new mongoose.Types.ObjectId(userId), tenantId: command.tenantId,
      activeTurnId: command.turnId, activeCommandId: command.commandId, activeAttemptId: command.attemptId,
      activeExecutionId: command.executionId, activeStage: 'generation', revision: 0, fenceToken: 1,
      status: 'running', accessRevokedAt: null,
    });
    await reservePersonalModelRequest({ mongoose: scope, command, quotedUpperUsd: 0.1, purpose: 'moderation' });
    await expect(reservePersonalModelRequest({ mongoose: scope, command, quotedUpperUsd: 0.1, purpose: 'moderation' }))
      .rejects.toMatchObject({ code: 'LIVE_MODEL_BUDGET_ALREADY_RESERVED' });
    await reservePersonalModelRequest({ mongoose: scope, command, quotedUpperUsd: 0.8, purpose: 'code' });
    const ledger = await scope.connection.db.collection('prototypemodelbudgets').findOne({ _id: command.turnId });
    expect(ledger.reservedMicros).toBe(900000);
    await expect(reservePersonalModelRequest({ mongoose: scope, command,
      quotedUpperUsd: 0.2, purpose: 'plan' })).rejects.toMatchObject({ code: 'LIVE_MODEL_BUDGET_EXCEEDED' });
    await expect(reservePersonalModelRequest({ mongoose: scope, command: { ...command, commandId: 'retry_content_budget' },
      quotedUpperUsd: 0.2, purpose: 'moderation' })).rejects.toMatchObject({ code: 'LIVE_MODEL_EXECUTION_STALE' });
    expect(await scope.connection.db.collection('prototypemodelreservations').countDocuments({ jobId: command.jobId })).toBe(2);
  } finally {
    if (previous === undefined) delete process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD;
    else process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD = previous;
  }
});
