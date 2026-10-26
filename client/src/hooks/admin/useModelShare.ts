import { useQuery } from '@tanstack/react-query';
import { request } from 'librechat-data-provider';
import { Period } from '~/common';

export interface ModelSharePoint {
  model: string;
  count: number;
  share: number;
}

async function fetchModelShare(period: Period, offset: number): Promise<ModelSharePoint[]> {
  return request.get<ModelSharePoint[]>(`/api/admin/model-share?period=${period}&offset=${offset}`);
}

export function useModelShare(period: Period, offset: number) {
  return useQuery<ModelSharePoint[]>({
    queryKey: ['adminModelShare', period, offset],
    queryFn: () => fetchModelShare(period, offset),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
