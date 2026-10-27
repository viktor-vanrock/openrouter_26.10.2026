import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  BookOpen,
  Megaphone,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
} from 'lucide-react';
import { cn } from '~/utils';
import { hasDevelopingCookie } from '~/utils/developingCookie';

const NAV_ITEMS = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/users', label: 'Users', icon: Users, end: false },
  { to: '/admin/guides', label: 'Инструкция по работе с сайтом', icon: BookOpen, end: false },
  { to: '/admin/releases', label: 'Релизы', icon: Megaphone, end: false },
];

export const AdminLayout = () => {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const visibleNavItems = hasDevelopingCookie()
    ? NAV_ITEMS
    : NAV_ITEMS.filter((item) => item.to !== '/admin/guides' && item.to !== '/admin/releases');

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileMenuOpen]);

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
          {visibleNavItems.map(({ to, label, icon: Icon, end }) => (
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

      <header className="flex h-12 shrink-0 items-center border-b border-border-light bg-surface-primary-alt px-3 min-[701px]:hidden">
        <NavLink
          to="/"
          aria-label="Назад на главную"
          className="flex h-9 items-center gap-1 rounded-lg px-2 text-sm text-text-primary hover:bg-surface-hover"
        >
          <ChevronLeft className="h-5 w-5" /> Назад
        </NavLink>
      </header>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
      {mobileMenuOpen && (
        <button
          type="button"
          aria-label="Закрыть меню"
          className="fixed inset-0 z-30 bg-black/30 min-[701px]:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
      {mobileMenuOpen && (
        <nav
          aria-label="Разделы админки"
          className="fixed bottom-14 left-0 right-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-border-light bg-surface-primary p-3 shadow-xl duration-200 animate-in slide-in-from-bottom-4 min-[701px]:hidden"
        >
          {visibleNavItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setMobileMenuOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex min-h-12 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
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
      )}
      <footer className="relative z-50 flex h-14 shrink-0 items-center justify-center border-t border-border-light bg-surface-primary-alt min-[701px]:hidden">
        <button
          type="button"
          aria-label={mobileMenuOpen ? 'Закрыть меню' : 'Открыть меню'}
          aria-expanded={mobileMenuOpen}
          onClick={() => setMobileMenuOpen((open) => !open)}
          className="flex h-12 w-12 items-center justify-center text-text-primary hover:text-text-secondary"
        >
          {mobileMenuOpen ? <X className="h-8 w-8" /> : <Menu className="h-8 w-8" />}
        </button>
      </footer>
    </div>
  );
};
