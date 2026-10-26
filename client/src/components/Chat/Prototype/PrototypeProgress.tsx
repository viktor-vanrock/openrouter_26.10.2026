import { useEffect, useState } from 'react';

const labels: Record<string, string> = {
  preparing: 'Готовимся к созданию прототипа…',
  transfer: 'Готовимся к созданию прототипа…',
  dependency_preparation: 'Готовимся к созданию прототипа…',
  planning: 'Продумываем экраны и сценарии…',
  generation: 'Создаём прототип…',
  build_qa: 'Проверяем, что прототип готов к просмотру…',
  publish: 'Готовим предпросмотр…',
};

export default function PrototypeProgress({
  phase,
  queued,
  disconnected,
}: {
  phase: string | null;
  queued: boolean;
  disconnected: boolean;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div
      role="status"
      aria-label="Прототип обрабатывается"
      className="mt-3 flex items-center gap-3 rounded-lg bg-violet-500/10 px-3 py-2 text-sm text-text-primary"
    >
      <span
        aria-hidden="true"
        className={`prototype-thinking size-3 shrink-0 rounded-full ${disconnected ? 'bg-amber-500' : 'bg-violet-500'}`}
      />
      <span className="min-w-0 flex-1">
        {disconnected
          ? 'Восстанавливаем связь. Результат пока не подтверждён…'
          : queued
            ? 'Запрос принят. Ожидаем начала работы…'
            : (labels[phase ?? ''] ?? 'Работаем над вашим запросом…')}
      </span>
      <span aria-hidden="true" className="shrink-0 tabular-nums text-text-secondary">
        {seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${seconds % 60} с`}
      </span>
    </div>
  );
}
