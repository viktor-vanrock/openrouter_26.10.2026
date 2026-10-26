const mongoose = require('mongoose');
const { createPrototypeStoreModels, createPrototypeMethods } = require('@librechat/data-schemas');
const { PrototypeServiceError } = require('./errors');

let activeStore;
let opening;
function getPrototypeStore() {
  if (!activeStore || activeStore.mongoose.connection.readyState !== 1) {
    throw new PrototypeServiceError('PROTOTYPE_SERVICE_UNAVAILABLE', 'Prototype storage is unavailable');
  }
  return activeStore;
}

/** Separate connection, explicitly configured in root env. Never changes primary mongoose. */
async function openPrototypeStore({ env = process.env, primary = mongoose } = {}) {
  if (activeStore?.mongoose.connection.readyState === 1) return activeStore;
  if (opening) return opening;
  opening = (async () => {
    const uri = env.PROTOTYPE_MONGO_URI;
    if (typeof uri !== 'string' || !uri.trim() || uri === env.MONGO_URI) {
      throw new Error('Explicit separate PROTOTYPE_MONGO_URI is required');
    }
    const scope = new mongoose.Mongoose();
    scope.set('bufferCommands', false);
    try {
      await scope.connect(uri, { serverSelectionTimeoutMS: 2_000, connectTimeoutMS: 2_000, maxPoolSize: 10 });
      const hello = await scope.connection.db.admin().command({ hello: 1 });
      if (!hello.setName || hello.isWritablePrimary !== true) throw new Error('Prototype store requires a writable replica set');
      if (scope.connection.db.databaseName === primary.connection.db?.databaseName &&
          scope.connection.host === primary.connection.host && scope.connection.port === primary.connection.port) {
        throw new Error('Prototype store must have a separate database scope');
      }
      const models = createPrototypeStoreModels(scope);
      await Promise.all(Object.values(models).map(model => model.init()));
      const methods = createPrototypeMethods(scope);
      const { PrototypeChatProjection } = require('./PrototypeChatProjection');
      const projection = new PrototypeChatProjection({ scope, primary });
      await projection.prepare();
      let revocationCursor;
      methods.reconcilePrototypePrimaryRevocations = async () => {
        const jobs = await models.PrototypeJob.find({ accessRevokedAt: null,
          ...(revocationCursor ? { _id: { $gt: revocationCursor } } : {}) }).sort({ _id: 1 }).limit(100).lean();
        revocationCursor = jobs.length === 100 ? jobs.at(-1)._id : undefined;
        for (const job of jobs) {
          try { await projection.requireAccessible({ user: String(job.userId), tenantId: job.tenantId, conversationId: job.conversationId }); }
          catch (error) {
            if (error.code !== 'PROTOTYPE_JOB_NOT_FOUND') throw error;
            await methods.revokePrototypeConversation({ userId: String(job.userId), tenantId: job.tenantId, conversationId: job.conversationId });
          }
        }
      };
      const project = methods.projectPrototypeWorkerEvent;
      methods.projectPrototypeWorkerEvent = async (input, session) => {
        const result = await project(input, session);
        const message = await models.Message.findOne({ messageId: input.event.eventId }, null, { session }).lean();
        if (message) await projection.enqueue('message', message, session);
        return result;
      };
      activeStore = { mongoose: scope, models, methods, projection,
        async stop() { if (activeStore?.mongoose === scope) activeStore = undefined; await scope.disconnect(); } };
      return activeStore;
    } catch (error) { await scope.disconnect(); throw error; }
  })();
  try { return await opening; } finally { opening = undefined; }
}
module.exports = { getPrototypeStore, openPrototypeStore };
