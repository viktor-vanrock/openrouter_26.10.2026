import { useQuery } from '@tanstack/react-query';
import { apiBaseUrl, request } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';

export default function usePrototypeAvailability() {
  const { user, isAuthenticated } = useAuthContext();
  const { data: config } = useGetStartupConfig();
  const enabled = config?.prototypeAgent?.enabled === true;
  const query = useQuery<{ available: boolean }>(
    ['prototype-availability', user?.id],
    ({ signal }) =>
      request.get(`${apiBaseUrl()}/api/prototypes/availability`, { signal, timeout: 2_000 }),
    {
      enabled: enabled && isAuthenticated && !!user?.id,
      staleTime: 0,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: false,
      cacheTime: 0,
    },
  );
  return (
    enabled && isAuthenticated && !!user?.id && !query.isError && query.data?.available === true
  );
}
