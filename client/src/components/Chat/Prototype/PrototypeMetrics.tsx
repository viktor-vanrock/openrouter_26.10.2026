import { useEffect, useState } from 'react';
import { apiBaseUrl, request } from 'librechat-data-provider';

type Estimate = {
  costLowUsd: number | null;
  costHighUsd: number | null;
};
type Metrics = {
  timing?: {
    elapsedSeconds: number;
    running: boolean;
    durationLowSeconds: number | null;
    durationHighSeconds: number | null;
    sampleSize: number;
  };
  estimate: Estimate | null;
  estimatePurpose: 'moderation' | 'plan' | 'code' | null;
  limitUsd: number;
  committedUsd: number;
  actualCostUsd: number | null;
  costComplete: boolean;
};

const duration = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)} мин ${value % 60} с`;
};
const money = (value: number) =>
  `$${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

export default function PrototypeMetrics({
  jobId,
  conversationId,
  turnId,
  status,
  revision,
}: {
  jobId: string;
  conversationId: string;
  turnId: string | null;
  status: string;
  revision: number;
}) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loadedAt, setLoadedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const working = ['queued', 'preparing', 'running'].includes(status);
  useEffect(() => {
    setMetrics(null);
  }, [jobId, turnId]);
  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await request.get<Metrics>(
          `${apiBaseUrl()}/api/prototypes/${encodeURIComponent(jobId)}/metrics?conversationId=${encodeURIComponent(conversationId)}`,
        );
        if (!canceled) {
          setMetrics(next);
          setLoadedAt(Date.now());
          setUnavailable(false);
        }
      } catch {
        if (!canceled) setUnavailable(true);
      } finally {
        if (!canceled && working) timer = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [jobId, conversationId, turnId, working, revision]);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);

  const estimate = metrics?.estimate;
  const timing = metrics?.timing;
  const elapsedSeconds =
    (timing?.elapsedSeconds ?? 0) +
    (working && timing?.running ? Math.max(0, now - loadedAt) / 1000 : 0);
  return (
    <div
      aria-label="Стоимость и время прототипа"
      className="mt-3 rounded-lg border border-border-light px-3 py-2 text-xs text-text-secondary"
    >
      {estimate ? (
        <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <p>
            <span className="font-medium text-text-primary">
              {metrics?.estimatePurpose === 'moderation'
                ? 'Оценка проверки содержания: '
                : metrics?.estimatePurpose === 'plan'
                  ? 'Оценка подготовки плана: '
                  : 'Оценка генерации: '}
            </span>
            {estimate.costLowUsd != null && estimate.costHighUsd != null
              ? `${money(estimate.costLowUsd)}–${money(estimate.costHighUsd)}`
              : 'стоимость уточняется'}
          </p>
          <p>
            <span className="font-medium text-text-primary">Примерное время: </span>
            {timing?.durationLowSeconds != null && timing.durationHighSeconds != null
              ? `${Math.max(1, Math.ceil(timing.durationLowSeconds / 60))}–${Math.max(1, Math.ceil(timing.durationHighSeconds / 60))} мин · по предыдущим запускам`
              : 'ещё нет завершённых запусков этой модели для оценки'}
          </p>
        </div>
      ) : (
        <p>
          {unavailable
            ? 'Оценка стоимости временно недоступна.'
            : 'Рассчитываем стоимость генерации…'}
        </p>
      )}
      <p className="mt-1">
        <span className="font-medium text-text-primary">Время выполнения: </span>
        {timing ? duration(elapsedSeconds) : 'получаем данные…'}
        <span className="ml-1">· без ожидания вашего ответа</span>
      </p>
      {metrics && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-border-light pt-2">
          <span>Лимит на запрос с повторами: {money(metrics.limitUsd)}</span>
          <span>Учтено в лимите: {money(metrics.committedUsd)}</span>
          {metrics.actualCostUsd != null && (
            <span>
              {metrics.costComplete ? 'Потрачено' : 'Подтверждённые расходы'}:{' '}
              {money(metrics.actualCostUsd)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
