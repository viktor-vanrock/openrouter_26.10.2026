import React, { useState, useEffect } from 'react';
import { StatisticsHeader } from './ui/StatisticsHeader';
import { StatisticsLoader } from './ui/StatisticsLoader';
import { StatisticsError } from './ui/StatisticsError';
import { StatisticsItem } from './ui/StatisticsItem';
import { LIMIT_RESET_STRING } from './consts';
import { OpenRouterKeyResponseData } from 'librechat-data-provider';
import { ERROR_NUMBER, OpenrouterError } from '../types';

interface Props {
  onClose: () => void;
  isOpen: boolean;
  statistics: OpenRouterKeyResponseData | null;
  isLoading: boolean;
  error: OpenrouterError;
  fetchStatistics: () => void;
}

const StatisticsModal: React.FC<Props> = ({
  onClose,
  isOpen,
  statistics,
  isLoading,
  error,
  fetchStatistics,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const isNeedStatisticsErrorText = error?.code && error?.code !== ERROR_NUMBER.INSUFFICIENT_FUNDS;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black bg-opacity-50" onClick={onClose} />

      <div className="relative mx-4 w-full max-w-md rounded-lg bg-surface-chat p-6 shadow-xl">
        <StatisticsHeader onClose={onClose} />
        <div className="mt-4">
          {isLoading && <StatisticsLoader />}
          {isNeedStatisticsErrorText && (
            <StatisticsError error={error.message || ''} fetchBalance={fetchStatistics} />
          )}
          {!isLoading && !isNeedStatisticsErrorText && statistics && (
            <div className="space-y-4">
              <StatisticsItem
                title="Лимит установлен на"
                text={LIMIT_RESET_STRING[statistics.limit_reset]}
              />
              <StatisticsItem
                title="Сумма лимита"
                text={`${(statistics.limit && statistics.limit.toLocaleString()) || 0} $`}
              />
              <StatisticsItem
                title="Осталось лимита"
                text={`${(statistics.limit_remaining && statistics.limit_remaining.toLocaleString()) || 0} $`}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StatisticsModal;
