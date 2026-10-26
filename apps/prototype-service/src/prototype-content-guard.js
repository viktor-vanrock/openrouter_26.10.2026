import { createHash } from 'node:crypto';
import { runAsSystem } from '@librechat/data-schemas';
import { LocalLiveModel } from './local-live-model.js';
import {
  PROTOTYPE_CONTENT_POLICY_VERSION,
  parseContentDecision,
} from './prototype-content-policy.js';

function rejected(code) {
  return Object.assign(new Error(code), { code });
}

/** Check the exact durable requirements before any generation or workspace reuse. */
export class PrototypeContentGuard {
  constructor({
    mongoose,
    models,
    methods,
    gatewayUrl,
    createModel = (options) => new LocalLiveModel(options),
    callbacks,
    active,
    signal,
  }) {
    Object.assign(this, {
      mongoose,
      models,
      methods,
      gatewayUrl,
      createModel,
      callbacks,
      active,
      signal,
    });
  }

  async check(command) {
    const controller = new AbortController();
    const parentSignal = this.signal();
    const signal = parentSignal
      ? AbortSignal.any([controller.signal, parentSignal])
      : controller.signal;
    let checking = false;
    const watch = setInterval(async () => {
      if (checking || signal.aborted) return;
      checking = true;
      try {
        if (Date.parse(command.deadlineAt) <= Date.now() || !(await this.active(command))) {
          controller.abort();
        }
      } catch {
        controller.abort();
      } finally {
        checking = false;
      }
    }, 500);
    watch.unref();
    try {
      return await this.checkActive(command, signal);
    } finally {
      clearInterval(watch);
    }
  }

  async checkActive(command, signal) {
    if (signal.aborted || Date.parse(command.deadlineAt) <= Date.now()) {
      throw rejected('LIVE_MODEL_EXECUTION_STALE');
    }
    if (!(await this.active(command))) throw rejected('LIVE_MODEL_EXECUTION_STALE');
    const turns = await this.models.PrototypeTurn.find({ jobId: command.jobId })
      .sort({ ordinal: 1 })
      .select('text turnId')
      .lean();
    if (
      !turns.length ||
      !turns.some((turn) => turn.turnId === command.turnId) ||
      turns.some((turn) => typeof turn.text !== 'string' || !turn.text.trim())
    ) {
      throw rejected('LIVE_MODEL_MODERATION_UNAVAILABLE');
    }
    const text = turns.map((turn) => turn.text).join('\n\nСледующее изменение:\n');
    const receipts = this.mongoose.connection.db.collection('prototypecontentchecks');
    const identity = {
      jobId: command.jobId,
      userId: String(command.userId),
      tenantId: command.tenantId,
      modelId: command.modelId,
      policyVersion: PROTOTYPE_CONTENT_POLICY_VERSION,
      requirementsDigest: createHash('sha256').update(JSON.stringify(turns)).digest('hex'),
    };
    const receiptId = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    let receipt = await receipts.findOne({ _id: receiptId });
    if (receipt && Object.keys(identity).some((key) => receipt[key] !== identity[key])) {
      throw rejected('LIVE_MODEL_MODERATION_UNAVAILABLE');
    }
    if (!receipt) {
      const values = await runAsSystem(() =>
        this.methods.getUserKeyValues({
          userId: command.userId,
          tenantId: command.tenantId,
          name: 'OpenRouter',
        }),
      );
      if (
        !values?.apiKey ||
        (values.baseURL && values.baseURL.replace(/\/$/, '') !== this.gatewayUrl)
      ) {
        throw rejected('LIVE_MODEL_MODERATION_UNAVAILABLE');
      }
      const model = this.createModel({
        key: values.apiKey,
        model: command.modelId,
        baseUrl: this.gatewayUrl,
        requireKeyLimit: false,
        signal,
      });
      let result;
      try {
        result = await model.moderatePrototype(text, this.callbacks(command, 'moderation'));
      } catch (error) {
        if (signal.aborted) throw rejected('LIVE_MODEL_EXECUTION_STALE');
        throw error;
      }
      const decision = parseContentDecision(JSON.stringify(result.moderation));
      if (signal.aborted || !(await this.active(command)))
        throw rejected('LIVE_MODEL_EXECUTION_STALE');
      receipt = {
        _id: receiptId,
        ...identity,
        ...decision,
        commandId: command.commandId,
        createdAt: new Date(),
      };
      // A reserved request with an unknown outcome is never automatically replayed.
      await receipts.insertOne(receipt);
    }
    const decision = parseContentDecision(
      JSON.stringify({ decision: receipt.decision, category: receipt.category }),
    );
    if (decision.decision === 'reject') throw rejected('LIVE_MODEL_CONTENT_BLOCKED');
  }
}
