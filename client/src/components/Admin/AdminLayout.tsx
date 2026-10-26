import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, Users, BookOpen, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '~/utils';

const NAV_ITEMS = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/users', label: 'Users', icon: Users, end: false },
  { to: '/admin/guides', label: 'Руководство к использованию', icon: BookOpen, end: false },
];

export const AdminLayout = () => {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex h-full flex-col overflow-hidden min-[701px]:flex-row">
      <aside
        className={cn(
          'relative hidden h-full flex-shrink-0 flex-col border-r border-border-light bg-surface-primary-alt transition-all duration-200 min-[701px]:flex',
          collapsed ? 'w-14' : 'w-52',
        )}
      >
        <div
          className={cn(
            'flex items-center px-3 py-4',
            collapsed ? 'justify-center' : 'justify-between',
          )}
        >
          {!collapsed && (
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
              Admin Panel
            </span>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="rounded-lg p-1.5 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 px-2">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-surface-active-alt text-text-primary'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                )
              }
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>
        {!collapsed && (
          <div className="mt-2 text-center text-xs text-text-tertiary">
            {`VERSION: ${__APP_VERSION__}`}
          </div>
        )}
        <div className="border-t border-border-light p-3">
          <NavLink
            to="/c/new"
            className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary"
          >
            {!collapsed && '← Back to Chat'}
            {collapsed && <ChevronLeft className="h-4 w-4" />}
          </NavLink>
        </div>
      </aside>

      <main className="order-1 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden min-[701px]:order-none">
        <Outlet />
      </main>
      <footer className="order-2 flex shrink-0 items-center gap-2 border-t border-border-light bg-surface-primary-alt p-2 min-[701px]:hidden">
        <NavLink
          to="/c/new"
          aria-label="Back to Chat"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        >
          <ChevronLeft className="h-5 w-5" />
        </NavLink>
        <nav aria-label="Admin navigation" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-surface-active-alt text-text-primary'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                )
              }
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </footer>
    </div>
  );
};
