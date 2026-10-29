import { Schema } from 'mongoose';
import type { IGuidePage } from '~/types/guidePage';

const guidePageSchema = new Schema<IGuidePage>(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    draftHtml: { type: String, required: true },
    publishedHtml: { type: String, default: '' },
    isPublished: { type: Boolean, default: false },
    hasUnpublishedChanges: { type: Boolean, default: false },
    size: { type: Number, required: true, min: 0, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

export default guidePageSchema;
