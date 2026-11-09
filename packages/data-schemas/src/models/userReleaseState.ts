import userReleaseStateSchema from '~/schema/userReleaseState';
import type { IUserReleaseState } from '~/types/release';

export function createUserReleaseStateModel(mongoose: typeof import('mongoose')) {
  return (
    mongoose.models.UserReleaseState ||
    mongoose.model<IUserReleaseState>('UserReleaseState', userReleaseStateSchema)
  );
}
