import type { Document, Types } from 'mongoose';

export interface IRelease extends Document {
  title: string;
  text: string;
  isPublished: boolean;
  publishedAt: Date | null;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  publishedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserReleaseState extends Document {
  userId: Types.ObjectId;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
