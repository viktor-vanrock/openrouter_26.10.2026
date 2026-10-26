import { useState } from 'react';
import StatisticsModal from './StatisticsModal';
import { useStatistics } from './hooks/useStatistics';
import { ButtonWithIndicator } from './ButtonWithIndicator';
import { ERROR_NUMBER } from './types';

interface Props {
  isNeedButton?: boolean;
}

export const OpenrouterButton = ({ isNeedButton = true }: Props) => {
  const [isOpen, setIsOpen] = useState(false);
  const { statistics, isLoading, error, fetchStatistics } = useStatistics();

  const handleOpen = () => setIsOpen(true);
  const handleClose = () => setIsOpen(false);

  const isNeedStatisticsModal = !(
    error?.code === ERROR_NUMBER.OPENROUTER_KEY_NOT_FOUND ||
    error?.code === ERROR_NUMBER.INVALID_API_KEY ||
    error?.code === ERROR_NUMBER.RATE_LIMIT
  );

  return (
    <>
      {isNeedButton && <ButtonWithIndicator handleClick={handleOpen} error={error} />}
      {!isNeedButton && (
        <div
          style={{ width: '100%', height: '50px', display: 'flex', alignItems: 'center' }}
          onClick={handleOpen}
        >
          Лимиты
        </div>
      )}
      {isNeedStatisticsModal && (
        <StatisticsModal
          onClose={handleClose}
          isOpen={isOpen}
          statistics={statistics}
          isLoading={isLoading}
          error={error}
          fetchStatistics={fetchStatistics}
        />
      )}
    </>
  );
};
