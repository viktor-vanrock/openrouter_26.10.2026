import { Schema } from 'mongoose';
import type { IRelease } from '~/types/release';

const releaseSchema = new Schema<IRelease>(
  {
    title: { type: String, trim: true, maxlength: 120, default: '' },
    text: { type: String, required: true, maxlength: 10000 },
    isPublished: { type: Boolean, default: false },
    publishedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export default releaseSchema;
