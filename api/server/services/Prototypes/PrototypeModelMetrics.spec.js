const mongoose = require('mongoose');
const { prototypeModelMetrics } = require('./PrototypeModelMetrics');
it('combines planner and agent receipts, preserving unknown charges and token/cost incompleteness', async () => {
  const oldDb = mongoose.connection.db;
  const oldJob = mongoose.models.PrototypeJob;
  mongoose.models.PrototypeJob = { findOne: jest.fn(() => ({ lean: async () => null })) };
  const oldUri = process.env.PROTOTYPE_MONGO_URI;
  delete process.env.PROTOTYPE_MONGO_URI;
  const records = { prototypeevents: [], prototypemodelmetrics: [{ turnId: 'turn', purpose: 'plan', status: 'settled', actualCostUsd: 0.01, promptTokens: 5 }],
    prototypeagentrequests: [{ turnId: 'turn', status: 'settled', actualMicros: 20000, promptTokens: 10, completionTokens: 20 },
      { turnId: 'turn', status: 'unknown', actualMicros: null }],
    prototypemodelbudgets: { reservedMicros: 10000 }, prototypeagentbudgets: { reservedMicros: 120000, maxMicros: 2000000 } };
  mongoose.connection.db = { collection: name => ({ find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => records[name] }) }) }),
    findOne: async () => records[name] }) };
  try {
    expect(await prototypeModelMetrics({ jobId: 'job', turnId: 'turn' })).toMatchObject({ committedUsd: 0.13,
      actualCostUsd: 0.03, limitUsd: 2, costComplete: false, promptTokens: 15, completionTokens: 20 });
  } finally {
    mongoose.connection.db = oldDb;
    if (oldJob === undefined) delete mongoose.models.PrototypeJob;
    else mongoose.models.PrototypeJob = oldJob;
    if (oldUri != null) process.env.PROTOTYPE_MONGO_URI = oldUri;
  }
});
