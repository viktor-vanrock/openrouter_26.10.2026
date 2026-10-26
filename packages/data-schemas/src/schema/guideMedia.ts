import { Schema } from 'mongoose';
import type { IGuideMedia } from '~/types/guideMedia';

const guideMediaSchema = new Schema<IGuideMedia>(
  {
    key: { type: String, required: true, unique: true },
    kind: { type: String, required: true, enum: ['image', 'video'] },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    originalName: { type: String, required: true, maxlength: 200 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

guideMediaSchema.index({ createdAt: -1 });
export default guideMediaSchema;
