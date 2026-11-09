import axios from 'axios';

export type AdminRelease = {
  _id: string;
  title: string;
  text: string;
  isPublished: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminReleasePage = { items: AdminRelease[]; nextCursor: string | null };
const base = '/api/admin/releases';

export const fetchAdminReleases = async (cursor?: string | null) =>
  (
    await axios.get<AdminReleasePage>(base, {
      params: { limit: 20, ...(cursor ? { cursor } : {}) },
    })
  ).data;

export const createRelease = async (content: { title: string; text: string }) =>
  (await axios.post<{ release: AdminRelease }>(base, content)).data.release;
export const updateRelease = async (id: string, content: { title: string; text: string }) =>
  (await axios.put<{ release: AdminRelease }>(`${base}/${id}`, content)).data.release;
export const deleteRelease = async (id: string) => axios.delete(`${base}/${id}`);
export const publishRelease = async (id: string) => axios.post(`${base}/${id}/publish`);
export const unpublishRelease = async (id: string) => axios.post(`${base}/${id}/unpublish`);

export function releaseErrorMessage(error: unknown) {
  return (
    (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    'Не удалось выполнить действие'
  );
}
