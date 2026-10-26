import { useQuery } from '@tanstack/react-query';
import { request } from 'librechat-data-provider';
import { Period } from '~/common';

export interface MessagePoint {
  label: string;
  startDate: Date;
  endDate?: Date;
  messages: number;
}

async function fetchMessageStats(period: Period, offset: number): Promise<MessagePoint[]> {
  return request.get<MessagePoint[]>(`/api/admin/message-stats?period=${period}&offset=${offset}`);
}

export function useMessageStats(period: Period, offset: number) {
  return useQuery<MessagePoint[]>({
    queryKey: ['adminMessageStats', period, offset],
    queryFn: () => fetchMessageStats(period, offset),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
