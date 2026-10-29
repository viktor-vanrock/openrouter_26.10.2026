import axios from 'axios';
import { useQuery } from '@tanstack/react-query';

export type GuideMeta = {
  _id: string;
  title: string;
  isPublished: boolean;
  hasUnpublishedChanges: boolean;
  size: number;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
};

export type GuideMediaMap = Record<string, { url: string; kind: 'image' | 'video' }>;
export type GuideMedia = {
  id: string;
  kind: 'image' | 'video';
  name: string;
  size: number;
  createdAt: string;
  url: string;
  snippet: string;
};

export type GuideMediaSize = 'small' | 'medium' | 'large';
const guideMediaWidths: Record<GuideMedia['kind'], Record<GuideMediaSize, number>> = {
  image: { small: 320, medium: 480, large: 720 },
  video: { small: 400, medium: 640, large: 880 },
};

export function guideMediaSnippet(media: GuideMedia, size: GuideMediaSize = 'medium'): string {
  const width = guideMediaWidths[media.kind][size];
  const src = `media/${media.id}`;
  const style = 'max-width:100%;height:auto;display:block;margin:16px auto';
  return media.kind === 'image'
    ? `<img src="${src}" alt="" width="${width}" style="${style}">`
    : `<video controls preload="metadata" playsinline width="${width}" style="${style}" src="${src}"></video>`;
}
export type GuideMediaListResponse = {
  media: GuideMedia[];
  mediaOrigin?: string;
  signingErrors?: number;
};
export type GuideFull = {
  guide: GuideMeta;
  html: string;
  media?: GuideMediaMap;
  mediaOrigin?: string;
};
export type PublishedGuide = {
  title: string;
  html: string;
  publishedAt: string;
  media?: GuideMediaMap;
  mediaOrigin?: string;
};

const base = '/api/admin/guides';

const previewQueue: Array<() => void> = [];
let activePreviewRequests = 0;
const maxPreviewRequests = 3;

function enqueuePreview<T>(request: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activePreviewRequests += 1;
      request()
        .then(resolve, reject)
        .finally(() => {
          activePreviewRequests -= 1;
          previewQueue.shift()?.();
        });
    };
    if (activePreviewRequests < maxPreviewRequests) run();
    else previewQueue.push(run);
  });
}

export const guideKeys = {
  list: ['adminGuides'] as const,
  one: (id: string) => ['adminGuide', id] as const,
  media: ['guideMedia'] as const,
};

export const fetchGuides = async () => (await axios.get<{ items: GuideMeta[] }>(base)).data.items;
export const fetchGuide = async (id: string) => (await axios.get<GuideFull>(`${base}/${id}`)).data;
export const fetchGuidePreview = async (id: string) => enqueuePreview(() => fetchGuide(id));
export const uploadGuide = async (file: File) => {
  const formData = new FormData();
  formData.append('file', file);
  return (await axios.post<GuideFull>(base, formData)).data;
};
export const saveGuide = async (id: string, html: string) =>
  (await axios.put<{ guide: GuideMeta }>(`${base}/${id}`, { html })).data;
export const deleteGuide = async (id: string) => axios.delete(`${base}/${id}`);
export const publishGuide = async (id: string) => axios.post(`${base}/${id}/publish`);
export const fetchPublishedGuide = async () =>
  (await axios.get<PublishedGuide>('/api/guides/published')).data;
export const fetchGuideMedia = async () => {
  const response = (await axios.get<GuideMediaListResponse>(`${base}/media`)).data;
  if (!Array.isArray(response?.media)) {
    throw new Error('Сервер вернул неверный список файлов');
  }
  return response;
};
export const uploadGuideMedia = async (
  file: File,
  signal: AbortSignal,
  onUploadProgress: (progress: number) => void,
) => {
  const formData = new FormData();
  formData.append('file', file);
  return (
    await axios.post<{ media: GuideMedia; mediaOrigin?: string }>(`${base}/media`, formData, {
      signal,
      onUploadProgress: (event) => onUploadProgress(event.total ? event.loaded / event.total : 0),
    })
  ).data;
};
export const deleteGuideMedia = async (id: string, force = false) =>
  axios.delete(`${base}/media/${id}${force ? '?force=1' : ''}`);

export const useGuides = () => useQuery({ queryKey: guideKeys.list, queryFn: fetchGuides });
export const useGuide = (id?: string, enabled = true) =>
  useQuery({
    queryKey: guideKeys.one(id ?? ''),
    queryFn: () => fetchGuide(id as string),
    enabled: Boolean(id) && enabled,
    staleTime: 30_000,
    refetchInterval: 45 * 60 * 1000,
  });
export const useGuidePreview = (id?: string) =>
  useQuery({
    queryKey: guideKeys.one(id ?? ''),
    queryFn: () => fetchGuidePreview(id as string),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
export const useGuideMedia = () =>
  useQuery({
    queryKey: guideKeys.media,
    queryFn: fetchGuideMedia,
    staleTime: 30 * 60 * 1000,
    refetchInterval: 45 * 60 * 1000,
    refetchOnWindowFocus: 'always',
  });
