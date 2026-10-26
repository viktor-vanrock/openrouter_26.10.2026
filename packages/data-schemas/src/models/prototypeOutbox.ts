import prototypeOutboxSchema from '~/schema/prototypeOutbox';
import type { IPrototypeOutbox } from '~/types/prototype';

export function createPrototypeOutboxModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.PrototypeOutbox ||
    mongoose.model<IPrototypeOutbox>('PrototypeOutbox', prototypeOutboxSchema)
  );
}
