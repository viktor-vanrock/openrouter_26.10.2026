import axios from 'axios';
import { useQuery } from '@tanstack/react-query';

export type ImageModel = {
  id: string;
  name: string;
  price: number | null;
  imagePrice: number | null;
  imageOutputPerMillion?: number;
  promptPerMillion?: number;
  completionPerMillion?: number;
  requestPrice?: number;
};
export type ImageModels = { models: ImageModel[]; defaultModel: string | null };
const key = (userId?: string) => `openrouter.imageModel.${userId ?? ''}`;
export function getSavedImageModel(userId?: string): string | undefined {
  if (!userId) return undefined;
  try {
    return localStorage.getItem(key(userId)) ?? undefined;
  } catch {
    return undefined;
  }
}
export function saveImageModel(userId: string, model: string) {
  try {
    localStorage.setItem(key(userId), model);
  } catch {
    /* Storage may be unavailable. */
  }
}
export function useImageModels(userId?: string) {
  return useQuery({
    queryKey: ['openrouter', 'image-models', userId],
    queryFn: async () => (await axios.get<ImageModels>('/api/openrouter/image-models')).data,
    enabled: !!userId,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
}
