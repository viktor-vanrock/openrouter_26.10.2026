import prototypeArtifactSchema from '~/schema/prototypeArtifact';
import type { IPrototypeArtifact } from '~/types/prototype';

export function createPrototypeArtifactModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.PrototypeArtifact ||
    mongoose.model<IPrototypeArtifact>('PrototypeArtifact', prototypeArtifactSchema)
  );
}
