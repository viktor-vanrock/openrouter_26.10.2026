import { cn } from '~/utils';
import { SystemRoles } from 'librechat-data-provider';

interface Props {
  role: string;
}

export const RoleBadge = ({ role }: Props) => {
  const isAdmin = role === SystemRoles.ADMIN;
  const badgeAdminColors =
    'border-red-700 bg-red-700/10 px-3 text-red-700 dark:border-red-500 dark:text-red-500';
  const badgeUserColors =
    'border-blue-700 bg-blue-900/10 text-blue-700 dark:border-blue-500 dark:bg-blue-900/30 dark:text-blue-300';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        isAdmin ? badgeAdminColors : badgeUserColors,
      )}
    >
      {role}
    </span>
  );
};
