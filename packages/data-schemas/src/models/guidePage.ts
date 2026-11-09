import guidePageSchema from '~/schema/guidePage';
import type { IGuidePage } from '~/types/guidePage';

export function createGuidePageModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.GuidePage || mongoose.model<IGuidePage>('GuidePage', guidePageSchema);
}
