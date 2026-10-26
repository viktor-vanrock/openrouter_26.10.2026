import { Navigate, Outlet } from 'react-router-dom';
import { SystemRoles } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks/AuthContext';

export const AdminRoute = () => {
  const { user, token, isAuthenticated } = useAuthContext();

  if (token === undefined && !isAuthenticated) {
    return null;
  }

  if (isAuthenticated && !user) {
    return null;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user?.role !== SystemRoles.ADMIN) {
    return <Navigate to="/c/new" replace />;
  }

  return <Outlet />;
};
