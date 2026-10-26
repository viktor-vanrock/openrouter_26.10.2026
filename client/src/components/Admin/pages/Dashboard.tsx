import { Users, ShieldCheck } from 'lucide-react';
import { useAdminStats } from '~/hooks/admin/useAdminStats';
import { AdminHeader } from '../components/AdminHeader';
import { StatCard } from '../components/StatCard';
import { UniqUserGraphic } from '../components/UniqUserGraphic';
import { NewUsersGraphic } from '../components/NewUsersGraphic';
import { MessageStatsGraphic } from '../components/MessageStatsGraphic';
import { ModelShareGraphic } from '../components/ModelShareGraphic';

export const AdminDashboard = () => {
  const { data: stats, isLoading, isError } = useAdminStats();

  return (
    <div className="flex flex-col overflow-auto">
      <AdminHeader title="Dashboard" breadcrumbs={[{ label: 'Admin' }, { label: 'Dashboard' }]} />
      <div className="flex-1 overflow-y-auto p-6">
        {isError && (
          <div className="mb-4 rounded-lg border border-red-700 bg-red-900/20 p-4 text-sm text-red-700">
            Failed to load statistics. Check that admin API endpoints are available.
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="Total Users"
            value={isLoading ? '...' : (stats?.totalUsers ?? 0)}
            icon={Users}
            color="text-blue-400"
          />
          <StatCard
            title="Administrators"
            value={isLoading ? '...' : (stats?.adminUsers ?? 0)}
            icon={ShieldCheck}
            color="text-red-400"
          />
        </div>
        {/* График уникальных пользователей по дням */}
        <UniqUserGraphic />
        {/* График новые зарегистрированные пользователи по дням*/}
        <NewUsersGraphic />
        {/* График сообщений пользователей */}
        <MessageStatsGraphic />
        {/* Круговая диаграмма популярности моделей */}
        <ModelShareGraphic />
      </div>
    </div>
  );
};
