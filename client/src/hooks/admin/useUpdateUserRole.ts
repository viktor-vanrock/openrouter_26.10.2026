import { useMutation, useQueryClient } from '@tanstack/react-query';
import { adminApi, type AdminUser } from '~/api/admin';

export function useUpdateUserRole() {
  const queryClient = useQueryClient();

  return useMutation<AdminUser, Error, { id: string; role: string }>({
    mutationFn: ({ id, role }) => adminApi.updateUserRole(id, role),
    onSuccess: (updated) => {
      queryClient.setQueryData<AdminUser[]>(['admin-users'], (prev) =>
        prev ? prev.map((u) => (u.id === updated.id ? updated : u)) : prev,
      );
      queryClient.invalidateQueries({ queryKey: ['admin-stats'] });
    },
  });
}
