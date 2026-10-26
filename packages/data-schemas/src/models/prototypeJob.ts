import prototypeJobSchema from '~/schema/prototypeJob';
import type { IPrototypeJob } from '~/types/prototype';

export function createPrototypeJobModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.PrototypeJob ||
    mongoose.model<IPrototypeJob>('PrototypeJob', prototypeJobSchema)
  );
}
