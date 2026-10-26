import { Schema } from 'mongoose';
import type { IPrototypeWorkerEventReceipt } from '~/types/prototype';

const prototypeWorkerEventReceiptSchema = new Schema<IPrototypeWorkerEventReceipt>(
  {
    eventId: { type: String, required: true },
    jobId: { type: String, required: true },
    commandId: { type: String, required: true },
    payloadType: { type: String, required: true },
    payloadDigest: { type: String, required: true, match: /^sha256:[a-f0-9]{64}$/ },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

prototypeWorkerEventReceiptSchema.index({ eventId: 1 }, { unique: true });
prototypeWorkerEventReceiptSchema.index({ jobId: 1, createdAt: 1 });

export default prototypeWorkerEventReceiptSchema;
