import type { LucideIcon } from 'lucide-react';

interface Props {
  title: string;
  value: number | string;
  icon: LucideIcon;
  color?: string;
}

export const StatCard = ({ title, value, icon: Icon, color = 'text-blue-400' }: Props) => {
  return (
    <div className="rounded-xl border border-border-light bg-[var(--bg-admin-card)] p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-text-secondary">{title}</p>
          <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
        </div>
        <Icon className={`h-8 w-8 ${color}`} />
      </div>
    </div>
  );
};
