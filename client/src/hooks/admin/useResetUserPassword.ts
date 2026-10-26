import { useMutation } from '@tanstack/react-query';
import { adminApi } from '~/api/admin';

export function useResetUserPassword() {
  return useMutation<{ message?: string; link?: string }, Error, string>({
    mutationFn: (id: string) => adminApi.resetUserPassword(id),
  });
}
