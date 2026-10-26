import { Schema } from 'mongoose';
import { createPrototypeJobModel } from './prototypeJob';
import { createPrototypeTurnModel } from './prototypeTurn';
import { createPrototypeEventModel } from './prototypeEvent';
import { createPrototypeArtifactModel } from './prototypeArtifact';
import { createPrototypeOutboxModel } from './prototypeOutbox';
import { createPrototypeWorkerEventReceiptModel } from './prototypeWorkerEventReceipt';
import { createPrototypeGatewayExecutionModel } from './prototypeGatewayExecution';
import messageSchema from '~/schema/message';
import convoSchema from '~/schema/convo';

/** Only prototype authority and message/conversation copies; no users, credentials or search plugins. */
export function createPrototypeStoreModels(mongoose: typeof import('mongoose')) {
  const message = new Schema(messageSchema.obj, { timestamps: true });
  message.index({ messageId: 1, user: 1, tenantId: 1 }, { unique: true });
  const conversation = new Schema(convoSchema.obj, { timestamps: true });
  conversation.index({ conversationId: 1, user: 1, tenantId: 1 }, { unique: true });
  return {
    Message: mongoose.models.Message || mongoose.model('Message', message),
    Conversation: mongoose.models.Conversation || mongoose.model('Conversation', conversation),
    PrototypeJob: createPrototypeJobModel(mongoose),
    PrototypeTurn: createPrototypeTurnModel(mongoose),
    PrototypeEvent: createPrototypeEventModel(mongoose),
    PrototypeArtifact: createPrototypeArtifactModel(mongoose),
    PrototypeOutbox: createPrototypeOutboxModel(mongoose),
    PrototypeWorkerEventReceipt: createPrototypeWorkerEventReceiptModel(mongoose),
    PrototypeGatewayExecution: createPrototypeGatewayExecutionModel(mongoose),
  };
}
