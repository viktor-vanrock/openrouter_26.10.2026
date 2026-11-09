import type { Document, Types } from 'mongoose';

export interface IGuidePage extends Document {
  title: string;
  draftHtml: string;
  publishedHtml: string;
  isPublished: boolean;
  hasUnpublishedChanges: boolean;
  size: number;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  publishedBy?: Types.ObjectId;
  publishedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
