import { useQuery } from '@tanstack/react-query';
import { request } from 'librechat-data-provider';
import { Period } from '~/common';
import { ActivityPoint } from './types';

async function fetchUserActivity(period: Period, offset: number): Promise<ActivityPoint[]> {
  return request.get<ActivityPoint[]>(`/api/admin/user-activity?period=${period}&offset=${offset}`);
}

export function useUserActivity(period: Period, offset: number) {
  return useQuery<ActivityPoint[]>({
    queryKey: ['adminUserActivity', period, offset],
    queryFn: () => fetchUserActivity(period, offset),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
