import type { Document, Types } from 'mongoose';

export interface IGuideMedia extends Document {
  key: string;
  kind: 'image' | 'video';
  contentType: string;
  size: number;
  originalName: string;
  createdBy: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}
