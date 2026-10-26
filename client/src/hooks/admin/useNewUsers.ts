import { useQuery } from '@tanstack/react-query';
import { request } from 'librechat-data-provider';
import { Period } from '~/common';
import { ActivityPoint } from './types';

async function fetchNewUsers(period: Period, offset: number): Promise<ActivityPoint[]> {
  return request.get<ActivityPoint[]>(`/api/admin/new-users?period=${period}&offset=${offset}`);
}

export function useNewUsers(period: Period, offset: number) {
  return useQuery<ActivityPoint[]>({
    queryKey: ['adminNewUsers', period, offset],
    queryFn: () => fetchNewUsers(period, offset),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
