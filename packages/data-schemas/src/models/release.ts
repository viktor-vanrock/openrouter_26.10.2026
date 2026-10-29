import releaseSchema from '~/schema/release';
import type { IRelease } from '~/types/release';

export function createReleaseModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.Release || mongoose.model<IRelease>('Release', releaseSchema);
}
