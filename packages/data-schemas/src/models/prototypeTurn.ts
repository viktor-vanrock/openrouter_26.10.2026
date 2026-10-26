import prototypeTurnSchema from '~/schema/prototypeTurn';
import type { IPrototypeTurn } from '~/types/prototype';

export function createPrototypeTurnModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.PrototypeTurn ||
    mongoose.model<IPrototypeTurn>('PrototypeTurn', prototypeTurnSchema)
  );
}
