import prototypeWorkerEventReceiptSchema from '~/schema/prototypeWorkerEventReceipt';
import type { IPrototypeWorkerEventReceipt } from '~/types/prototype';

export function createPrototypeWorkerEventReceiptModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.PrototypeWorkerEventReceipt ||
    mongoose.model<IPrototypeWorkerEventReceipt>(
      'PrototypeWorkerEventReceipt',
      prototypeWorkerEventReceiptSchema,
    )
  );
}
