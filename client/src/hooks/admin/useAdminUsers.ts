import { useQuery } from '@tanstack/react-query';
import { adminApi, type PagedUsersResponse, type UsersQueryParams } from '~/api/admin';

const QUERY_KEY = 'admin-users';

export function useAdminUsers(params?: UsersQueryParams) {
  return useQuery<PagedUsersResponse>({
    queryKey: [QUERY_KEY, params],
    queryFn: () => adminApi.getUsers(params),
    staleTime: 1000 * 30,
    keepPreviousData: true,
  });
}
