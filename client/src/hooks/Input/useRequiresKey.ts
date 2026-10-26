import { getEndpointField } from 'librechat-data-provider';
import { useChatContext } from '~/Providers/ChatContext';
import { useGetEndpointsQuery } from '~/data-provider';
import useUserKey from './useUserKey';

export default function useRequiresKey() {
  const { conversation } = useChatContext();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { endpoint } = conversation || {};
  const userProvidesKey: boolean | null | undefined = getEndpointField(
    endpointsConfig,
    endpoint,
    'userProvide',
  );
  const { hasKey } = useUserKey(endpoint ?? '');
  const requiresKey = !hasKey() && userProvidesKey;
  return { requiresKey };
}
