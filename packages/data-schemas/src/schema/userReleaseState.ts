import { Schema } from 'mongoose';
import type { IUserReleaseState } from '~/types/release';

const userReleaseStateSchema = new Schema<IUserReleaseState>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export default userReleaseStateSchema;
