import { useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EModelEndpoint } from 'librechat-data-provider';
import { useUserKeyQuery, useUpdateUserKeysMutation } from 'librechat-data-provider/react-query';
import { useGetEndpointsQuery } from '~/data-provider';

const useUserKey = (endpoint: string) => {
  const queryClient = useQueryClient();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const config = endpointsConfig?.[endpoint ?? ''];

  const { azure } = config ?? {};
  let keyName = endpoint;

  if (azure) {
    keyName = EModelEndpoint.azureOpenAI;
  }

  const updateKey = useUpdateUserKeysMutation();
  const checkUserKey = useUserKeyQuery(keyName);

  const getExpiry = useCallback(() => {
    if (checkUserKey.data) {
      return checkUserKey.data.expiresAt || 'never';
    }
  }, [checkUserKey.data]);

  const hasKey = useCallback(() => {
    return checkUserKey.data?.expiresAt != null;
  }, [checkUserKey.data]);

  const checkExpiry = useCallback(() => {
    const expiresAt = getExpiry();
    if (!expiresAt) {
      return true;
    }

    const expiresAtDate = new Date(expiresAt);
    if (expiresAtDate < new Date()) {
      return false;
    }
    return true;
  }, [getExpiry]);

  const saveUserKey = useCallback(
    (
      userKey: string,
      expiresAt: number | null,
      options?: { onSuccess?: () => void; onError?: (error: unknown) => void },
    ) => {
      const dateStr = expiresAt ? new Date(expiresAt).toISOString() : '';
      updateKey.mutate(
        {
          name: keyName,
          value: userKey,
          expiresAt: dateStr,
        },
        {
          onSuccess: () => {
            if (keyName === 'OpenRouter')
              void queryClient.invalidateQueries(['openrouter', 'model-prices']);
            options?.onSuccess?.();
          },
          onError: options?.onError,
        },
      );
    },
    [updateKey, keyName, queryClient],
  );

  return useMemo(
    () => ({ getExpiry, checkExpiry, saveUserKey, hasKey }),
    [getExpiry, checkExpiry, saveUserKey, hasKey],
  );
};

export default useUserKey;
