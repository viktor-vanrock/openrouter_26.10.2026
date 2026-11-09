import guideMediaSchema from '~/schema/guideMedia';
import type { IGuideMedia } from '~/types/guideMedia';
export function createGuideMediaModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.GuideMedia || mongoose.model<IGuideMedia>('GuideMedia', guideMediaSchema);
}
