import { useQuery } from '@tanstack/react-query';
import { SystemRoles } from 'librechat-data-provider';
import { adminApi, type AdminStats } from '~/api/admin';

async function fetchStats(): Promise<AdminStats> {
  const [allUsers, adminPage] = await Promise.all([
    adminApi.getUsers({ limit: 200 }),
    adminApi.getUsers({ limit: 1, role: SystemRoles.ADMIN }),
  ]);

  const recent = [...allUsers.users]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  return {
    totalUsers: allUsers.total,
    adminUsers: adminPage.total,
    recentUsers: recent,
  };
}

export function useAdminStats() {
  return useQuery<AdminStats>({
    queryKey: ['admin-stats'],
    queryFn: fetchStats,
    staleTime: 1000 * 60,
  });
}
