import axios from 'axios';
import { useQuery } from '@tanstack/react-query';

export type ReleaseItem = {
  id: string;
  title: string;
  text: string;
  publishedAt: string;
  isUnread: boolean;
};
export type ReleasePage = { items: ReleaseItem[]; nextCursor: string | null; lastSeenAt: string };
export type UnreadResponse = { items: ReleaseItem[]; unreadCount: number; lastSeenAt: string };
export type ReleaseStatus = { unreadCount: number; latestPublishedAt: string | null };

export const releaseKeys = {
  status: ['releases', 'status'] as const,
  unread: ['releases', 'unread'] as const,
  list: ['releases', 'list'] as const,
};

export const getReleaseStatus = async () =>
  (await axios.get<ReleaseStatus>('/api/releases/status')).data;
export const getUnreadReleases = async () =>
  (await axios.get<UnreadResponse>('/api/releases/unread', { params: { limit: 5 } })).data;
export const getReleases = async (cursor?: string | null) =>
  (
    await axios.get<ReleasePage>('/api/releases', {
      params: { limit: 20, ...(cursor ? { cursor } : {}) },
    })
  ).data;
export const markReleasesSeen = async (seenUpTo: string) =>
  (await axios.post<{ unreadCount: number }>('/api/releases/seen', { seenUpTo })).data;

export const useReleasesStatus = () =>
  useQuery({
    queryKey: releaseKeys.status,
    queryFn: getReleaseStatus,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: 'always',
  });
