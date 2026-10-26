import { TooltipAnchor } from '@librechat/client';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';

export const AdminPanel = () => {
  return (
    <TooltipAnchor
      side="right"
      description="Admin Panel"
      render={
        <Link
          to="/admin"
          aria-label="Admin Panel"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-active-alt hover:text-text-primary"
        >
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </Link>
      }
    />
  );
};
