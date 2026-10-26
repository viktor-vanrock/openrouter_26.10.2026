import prototypeEventSchema from '~/schema/prototypeEvent';
import type { IPrototypeEvent } from '~/types/prototype';

export function createPrototypeEventModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.PrototypeEvent ||
    mongoose.model<IPrototypeEvent>('PrototypeEvent', prototypeEventSchema)
  );
}
