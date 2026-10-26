import { useState } from 'react';
import { SystemRoles } from 'librechat-data-provider';
import { useAdminUsers } from '~/hooks/admin/useAdminUsers';
import type { AdminUser } from '~/api/admin';
import { AdminHeader } from '../components/AdminHeader';
import { DataTable, type Column } from '../components/DataTable';
import { SearchInput } from '../components/SearchInput';
import { RoleBadge } from '../components/RoleBadge';
import { UserEditModal } from '../components/UserEditModal';

const PAGE_SIZE = 10;
type FilterRole = 'ALL' | 'ADMIN' | 'USER';

export const AdminUsers = () => {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState<FilterRole>('ALL');
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);

  const { data, isLoading, isError } = useAdminUsers({
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    role: filterRole !== 'ALL' ? filterRole : undefined,
    q: search || undefined,
  });

  const users = data?.users ?? [];
  const total = data?.total ?? 0;

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const handleRoleChange = (role: FilterRole) => {
    setFilterRole(role);
    setPage(1);
  };

  const columns: Column<AdminUser>[] = [
    { key: 'name', header: 'Name', render: (u) => <span className="font-medium">{u.name}</span> },
    {
      key: 'email',
      header: 'Email',
      render: (u) => <span className="text-text-secondary">{u.email}</span>,
    },
    { key: 'role', header: 'Role', render: (u) => <RoleBadge role={u.role} /> },
    {
      key: 'createdAt',
      header: 'Joined',
      render: (u) => (
        <span className="text-text-secondary">{new Date(u.createdAt).toLocaleDateString()}</span>
      ),
    },
  ];

  return (
    <div className="flex flex-col">
      <AdminHeader title="Users" breadcrumbs={[{ label: 'Admin' }, { label: 'Users' }]} />
      <div className="flex-1 overflow-y-auto p-6">
        {isError && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-900/20 p-4 text-sm text-red-300">
            Failed to load users.
          </div>
        )}

        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex-1">
            <SearchInput placeholder="Search by name or email..." onSearch={handleSearch} />
          </div>
          <select
            value={filterRole}
            onChange={(e) => handleRoleChange(e.target.value as FilterRole)}
            className="rounded-lg border border-border-light bg-surface-secondary px-3 py-2 text-sm text-text-primary focus:border-blue-500 focus:outline-none"
          >
            <option value="ALL">All Roles</option>
            <option value={SystemRoles.ADMIN}>{SystemRoles.ADMIN}</option>
            <option value={SystemRoles.USER}>{SystemRoles.USER}</option>
          </select>
        </div>

        <div className="overflow-hidden rounded-xl border border-border-light bg-surface-primary-alt">
          <DataTable
            data={users}
            columns={columns}
            pageSize={PAGE_SIZE}
            loading={isLoading}
            emptyMessage="No users found"
            onRowClick={setEditingUser}
            total={total}
            page={page}
            onPageChange={setPage}
          />
        </div>
      </div>

      <UserEditModal user={editingUser} onClose={() => setEditingUser(null)} />
    </div>
  );
};
