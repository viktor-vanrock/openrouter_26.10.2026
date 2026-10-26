import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { SystemRoles } from 'librechat-data-provider';
import type { AdminUser } from '~/api/admin';
import { useUpdateUserRole } from '~/hooks/admin/useUpdateUserRole';
import { useResetUserPassword } from '~/hooks/admin/useResetUserPassword';
import { RoleBadge } from './RoleBadge';

interface Props {
  user: AdminUser | null;
  onClose: () => void;
}

const ROLES = [SystemRoles.USER, SystemRoles.ADMIN];

export const UserEditModal = ({ user, onClose }: Props) => {
  const [selectedRole, setSelectedRole] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetResult, setResetResult] = useState<{ message?: string; link?: string } | null>(null);
  const { mutate, isLoading, error, reset } = useUpdateUserRole();
  const { mutate: resetPassword, isLoading: isResetting } = useResetUserPassword();

  useEffect(() => {
    if (user) {
      setSelectedRole(user.role);
      reset();
      setShowConfirm(false);
      setShowResetConfirm(false);
      setResetResult(null);
    }
  }, [user, reset]);

  if (!user) return null;

  const hasChange = selectedRole !== user.role;

  function handleSave() {
    if (!hasChange) return;
    setShowConfirm(true);
  }

  function handleConfirm() {
    setShowConfirm(false);
    mutate({ id: user!.id, role: selectedRole }, { onSuccess: onClose });
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleResetPasswordConfirm() {
    setShowResetConfirm(false);
    resetPassword(user!.id, {
      onSuccess: (data) => setResetResult(data),
    });
  }
  // styles
  const badgeAdminColors =
    'border-red-700 bg-red-700/10 px-3 text-red-700 dark:border-red-500 dark:text-red-500';
  const badgeUserColors =
    'border-blue-700 bg-blue-900/10 text-blue-700 dark:border-blue-500 dark:bg-blue-900/30 dark:text-blue-300';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="w-full max-w-md rounded-2xl border border-border-light bg-surface-primary p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Edit User</h2>
            <p className="mt-0.5 text-sm text-text-secondary">{user.email}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-2 flex items-center gap-3 rounded-lg bg-surface-secondary px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text-primary">{user.name}</p>
            {user.username && (
              <p className="truncate text-xs text-text-secondary">@{user.username}</p>
            )}
          </div>
          <RoleBadge role={user.role} />
        </div>

        <div className="mb-6 mt-5">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
            Role
          </p>
          <div className="flex gap-2">
            {ROLES.map((role) => (
              <button
                key={role}
                onClick={() => setSelectedRole(role)}
                className={`flex-1 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                  selectedRole === role
                    ? role === SystemRoles.ADMIN
                      ? badgeAdminColors
                      : badgeUserColors
                    : 'border-border-light bg-surface-secondary text-text-secondary hover:bg-surface-hover'
                }`}
              >
                {role}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
            Пароль
          </p>
          {resetResult ? (
            <div className="rounded-lg border border-green-600 bg-green-600/10 px-3 py-2">
              {resetResult.link ? (
                <div>
                  <p className="mb-1 text-xs text-green-700 dark:text-green-400">
                    Ссылка для сброса пароля:
                  </p>
                  <a
                    href={resetResult.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-xs text-blue-600 underline dark:text-blue-400"
                  >
                    {resetResult.link}
                  </a>
                </div>
              ) : (
                <p className="text-xs text-green-700 dark:text-green-400">
                  {resetResult.message || 'Письмо со ссылкой отправлено пользователю.'}
                </p>
              )}
            </div>
          ) : (
            <button
              onClick={() => setShowResetConfirm(true)}
              disabled={isResetting}
              className="w-full rounded-lg border border-border-light bg-surface-secondary px-3 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isResetting ? 'Отправка…' : 'Сбросить пароль'}
            </button>
          )}
        </div>

        {error && (
          <p className={`${badgeAdminColors} mb-4 rounded-lg border px-3 py-2 text-xs`}>
            {error.message || 'Failed to update role'}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChange || isLoading}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isLoading ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {showConfirm && (
        <div className="z-60 fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-border-light bg-surface-primary p-6 shadow-2xl">
            <p className="mb-6 text-sm text-text-primary">Вы действительно хотите поменять роль?</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover"
              >
                Отмена
              </button>
              <button
                onClick={handleConfirm}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Да
              </button>
            </div>
          </div>
        </div>
      )}

      {showResetConfirm && (
        <div className="z-60 fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-border-light bg-surface-primary p-6 shadow-2xl">
            <p className="mb-2 text-sm text-text-primary">
              Отправить ссылку для сброса пароля пользователю?
            </p>
            <p className="mb-6 text-xs text-text-secondary">{user?.email}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover"
              >
                Отмена
              </button>
              <button
                onClick={handleResetPasswordConfirm}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Отправить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
