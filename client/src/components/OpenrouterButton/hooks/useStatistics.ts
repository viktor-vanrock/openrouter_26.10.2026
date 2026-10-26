import { OpenRouterKeyResponseData } from 'librechat-data-provider';
import { useState, useEffect, useCallback } from 'react';
import { useAuthContext } from '~/hooks/AuthContext';
import { useCurrentKey } from '~/Providers';
import { ApiError } from '../utils';
import { fetchOpenrouterBalance } from '~/common/api/fetchStatistics';
import { ERROR_NUMBER } from '../types';

export const useStatistics = () => {
  const { token } = useAuthContext();
  const [statistics, setStatistics] = useState<OpenRouterKeyResponseData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<{ message: string | null; code?: number } | null>(null);
  const { hasCurrentKey, setOpenDealogSetKey, setTextErrorOpenRouterKey } = useCurrentKey();

  const fetchStatistics = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchOpenrouterBalance(token as string);

      setStatistics(result.data);
      setOpenDealogSetKey(false);
      setTextErrorOpenRouterKey('');
    } catch (err) {
      if (err instanceof ApiError) {
        setError({ message: err.message || 'Произошла неизвестная ошибка', code: err.statusCode });
        setStatistics(null);
        if (
          err?.statusCode === ERROR_NUMBER.OPENROUTER_KEY_NOT_FOUND ||
          err?.statusCode === ERROR_NUMBER.INVALID_API_KEY
        ) {
          setOpenDealogSetKey(true);
          setTextErrorOpenRouterKey(err.message);
        }
      } else {
        setError({ message: 'Произошла неизвестная ошибка' });
        setStatistics(null);
      }
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetchStatistics();
    }
  }, [token, fetchStatistics, hasCurrentKey]);

  return {
    statistics,
    isLoading,
    error,
    fetchStatistics,
  };
};
