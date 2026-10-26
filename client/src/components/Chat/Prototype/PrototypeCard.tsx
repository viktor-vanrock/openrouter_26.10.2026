import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@librechat/client';
import { Download, RotateCcw, Square, WandSparkles } from 'lucide-react';
import { useSetRecoilState } from 'recoil';
import { useQueryClient } from '@tanstack/react-query';
import { SSE } from 'sse.js';
import { isAxiosError } from 'axios';
import {
  apiBaseUrl,
  dataService,
  getTokenHeader,
  QueryKeys,
  request,
  type PrototypeCardData,
} from 'librechat-data-provider';
import store from '~/store';
import { useShareContext } from '~/Providers';
import PrototypeProgress from './PrototypeProgress';
import PrototypeMetrics from './PrototypeMetrics';

function actionKey(action: string) {
  return `${action}:${crypto.randomUUID()}`;
}

function responseFilename(disposition: unknown, fallback: string) {
  if (typeof disposition !== 'string') return fallback;
  return disposition.match(/filename="([^"]+)"/)?.[1] ?? fallback;
}

const statusLabels: Record<PrototypeCardData['status'], string> = {
  queued: 'в очереди',
  preparing: 'подготовка',
  running: 'выполняется',
  waiting_for_input: 'нужен ваш ответ',
  review: 'готов к проверке',
  waiting_for_credentials: 'нужны учётные данные',
  waiting_for_funds: 'нужны средства',
  completed: 'завершён',
  failed: 'ошибка',
  canceled: 'отменён',
};
const phaseLabels: Record<string, string> = {
  preparing: 'подготовка',
  planning: 'планирование',
  generation: 'генерация',
  transfer: 'подготовка',
  dependency_preparation: 'подготовка',
  build_qa: 'проверка готовности',
  publish: 'подготовка предпросмотра',
};
const activityLabels: Record<string, string> = {
  generation: 'Создаём прототип',
  transfer: 'Подготавливаем исходники',
  dependency_preparation: 'Подготавливаем сборку',
  build_qa: 'Проверяем готовность прототипа',
  publish: 'Готовим предпросмотр',
  'Prototype is waiting for your response': 'Прототип ждёт вашего ответа',
  'Prototype is running': 'Прототип выполняется',
  'A verified prototype version is ready for review':
    'Проверенная версия прототипа готова к просмотру',
  'Prototype version completed': 'Создание прототипа завершено',
  'Prototype execution canceled': 'Создание прототипа отменено',
  'Plan ready': 'План готов',
  'Prototype stage completed': 'Этап прототипа завершён',
  'Prototype stage failed': 'Этап прототипа завершился с ошибкой',
};
const completedActivityLabels: Record<string, string> = {
  generation: 'Исходники прототипа подготовлены',
  transfer: 'Исходники переданы на проверку',
  dependency_preparation: 'Окружение сборки подготовлено',
  build_qa: 'Проверка готовности завершена',
  publish: 'Предпросмотр подготовлен',
};
function activityMessage(item: PrototypeCardData['activity'][number]) {
  if (item.message === 'Prototype stage completed') {
    return completedActivityLabels[item.phase ?? ''] ?? 'Шаг подготовки выполнен';
  }
  return activityLabels[item.message] ?? item.message;
}

export default function PrototypeCard({ conversationId }: { conversationId: string }) {
  const [card, setCard] = useState<PrototypeCardData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const cursor = useRef(-1);
  const bindingEpoch = useRef(0);
  const { isSharedConvo } = useShareContext();
  const queryClient = useQueryClient();
  const setPrototypePreview = useSetRecoilState(store.prototypePreview);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const setDurableCard = useSetRecoilState(store.prototypeCardByConvoId(conversationId));
  const setPrototypeMode = useSetRecoilState(store.prototypeModeByConvoId(conversationId));

  const apply = useCallback(
    (next: PrototypeCardData) => {
      if (next.conversationId !== conversationId || next.cursor <= cursor.current) return false;
      cursor.current = next.cursor;
      setCard(next);
      setDurableCard(next);
      const htmlDigest = next.versions.at(-1)?.htmlDigest;
      setPrototypePreview((current) =>
        current?.jobId === next.jobId && current.htmlDigest !== htmlDigest
          ? { ...current, htmlDigest }
          : current,
      );
      setError(null);
      setDisconnected(false);
      return true;
    },
    [conversationId, setDurableCard, setPrototypePreview],
  );

  useEffect(() => {
    bindingEpoch.current++;
    cursor.current = -1;
    setCard(null);
    setBusy(null);
    setError(null);
    setDisconnected(false);
    setDurableCard(null);
    if (isSharedConvo) return;
    let canceled = false;
    let stream: SSE | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      void dataService
        .getConversationPrototype(conversationId)
        .then((snapshot) => {
          if (canceled) return;
          if (apply(snapshot)) {
            void queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
          }
          const authorization = getTokenHeader();
          stream = new SSE(
            `${apiBaseUrl()}/api/conversations/${encodeURIComponent(conversationId)}/prototype/events?cursor=${snapshot.cursor}`,
            {
              method: 'GET',
              start: false,
              autoReconnect: true,
              reconnectDelay: 1_000,
              useLastEventId: true,
              headers: {
                Accept: 'text/event-stream',
                ...(authorization ? { Authorization: authorization } : {}),
              },
            },
          );
          stream.addEventListener('job_state', (raw) => {
            if (canceled) return;
            const event = raw as MessageEvent<string>;
            try {
              const next = JSON.parse(event.data) as PrototypeCardData;
              if (apply(next)) {
                void queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
              }
            } catch {
              setError(
                'Не удалось получить обновление. Обновите чат, чтобы увидеть текущий результат.',
              );
            }
          });
          stream.addEventListener('open', () => {
            if (!canceled) {
              setError(null);
              setDisconnected(false);
            }
          });
          stream.addEventListener(
            'error',
            async (raw: MessageEvent<string> & { responseCode?: number }) => {
              if (canceled) return;
              setDisconnected(true);
              if (raw.responseCode === 401 && stream) {
                try {
                  const refreshed = await request.refreshToken();
                  if (!canceled && refreshed?.token) {
                    stream.headers = {
                      ...stream.headers,
                      Authorization: `Bearer ${refreshed.token}`,
                    };
                    request.dispatchTokenUpdatedEvent(refreshed.token);
                    return;
                  }
                } catch {
                  // Fall through to the durable-recovery warning.
                }
              }
              if (!canceled) setError('Связь прервалась. Восстанавливаем обновления…');
            },
          );
          stream.stream();
        })
        .catch((snapshotError) => {
          if (canceled || (isAxiosError(snapshotError) && snapshotError.response?.status === 404))
            return;
          setError('Не удалось загрузить состояние прототипа. Пробуем ещё раз…');
          retryTimer = setTimeout(load, 1_000);
        });
    load();
    return () => {
      canceled = true;
      bindingEpoch.current++;
      clearTimeout(retryTimer);
      stream?.close();
    };
  }, [apply, conversationId, isSharedConvo, queryClient, setDurableCard]);

  const runAction = async (action: 'approve' | 'cancel' | 'retry' | 'finalize') => {
    if (!card || busy) return;
    const epoch = bindingEpoch.current;
    setBusy(action);
    setError(null);
    try {
      const next = await {
        approve: dataService.approvePrototype,
        cancel: dataService.cancelPrototype,
        retry: dataService.retryPrototype,
        finalize: dataService.finalizePrototype,
      }[action](card.jobId, conversationId, actionKey(action), card.revision);
      if (epoch === bindingEpoch.current) apply(next as PrototypeCardData);
    } catch (actionError) {
      if (epoch !== bindingEpoch.current) return;
      if (isAxiosError(actionError) && actionError.response?.status === 409) {
        try {
          const snapshot = await dataService.getConversationPrototype(conversationId);
          if (epoch !== bindingEpoch.current) return;
          if (snapshot.conversationId === conversationId && snapshot.cursor >= cursor.current) {
            apply(snapshot);
            setError(null);
            return;
          }
        } catch {
          // Preserve the action failure until a later durable update can recover it.
        }
      }
      setError('Не удалось выполнить действие. Дождитесь обновления и попробуйте ещё раз.');
    } finally {
      if (epoch === bindingEpoch.current) setBusy(null);
    }
  };

  const download = async (kind: 'html' | 'sources', version?: number) => {
    if (!card || busy) return;
    const epoch = bindingEpoch.current;
    setBusy(`download-${kind}`);
    setError(null);
    try {
      const response = await (kind === 'html'
        ? dataService.getPrototypeHtmlDownload(card.jobId, conversationId, version)
        : dataService.getPrototypeSources(card.jobId, conversationId, version));
      if (epoch !== bindingEpoch.current) return;
      const fallback =
        kind === 'html'
          ? `prototype-${card.jobId}${version == null ? '' : `-r${version}`}.html`
          : `prototype-${card.jobId}${version == null ? '' : `-r${version}`}-sources.zip`;
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = responseFilename(response.headers['content-disposition'], fallback);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      if (epoch === bindingEpoch.current)
        setError('Не удалось скачать прототип. Попробуйте ещё раз.');
    } finally {
      if (epoch === bindingEpoch.current) setBusy(null);
    }
  };

  const chooseVariant = async (variant: 'A' | 'B') => {
    if (!card || busy || card.status !== 'review' || !card.promptMessageId || card.selectedVariant)
      return;
    const epoch = bindingEpoch.current;
    setBusy(`variant-${variant}`);
    setError(null);
    const messageId = crypto.randomUUID();
    try {
      await dataService.saveMessage(conversationId, {
        messageId,
        conversationId,
        parentMessageId: card.promptMessageId,
        text: `Выбираю вариант ${variant}. Сохрани его для всех последующих доработок.`,
        sender: 'User',
        isCreatedByUser: true,
        model: card.modelId,
        error: false,
        metadata: { prototypeAgent: true, prototypeReplyToMessageId: card.promptMessageId },
      });
      const next = await dataService.replyToPrototype(
        card.jobId,
        conversationId,
        { messageId, prototypeReplyToMessageId: card.promptMessageId, selectedVariant: variant },
        `reply:${messageId}`,
        card.revision,
      );
      if (epoch === bindingEpoch.current) {
        apply(next);
        void queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
      }
    } catch {
      if (epoch === bindingEpoch.current)
        setError('Не удалось зафиксировать вариант. Обновите чат и повторите выбор.');
    } finally {
      if (epoch === bindingEpoch.current) setBusy(null);
    }
  };

  if (isSharedConvo) return null;
  if (!card || card.conversationId !== conversationId) {
    return error ? (
      <p role="status" className="mx-auto my-4 max-w-3xl text-sm text-text-secondary">
        {error}
      </p>
    ) : null;
  }

  return (
    <section
      aria-label="Prototype task"
      className="mx-auto my-4 w-full max-w-3xl rounded-2xl border border-violet-500/30 bg-surface-secondary p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <WandSparkles className="size-5 text-violet-500" aria-hidden="true" />
          <div>
            <h2 className="font-semibold text-text-primary">Прототип</h2>
            <p className="text-xs text-text-secondary">
              {statusLabels[card.status]}
              {!['completed', 'canceled', 'failed'].includes(card.status) &&
                ` · ${phaseLabels[card.phase ?? 'preparing'] ?? 'обработка'}`}{' '}
              · {card.modelId}
            </p>
          </div>
        </div>
        {busy && <Spinner size={16} />}
      </div>

      {['queued', 'preparing', 'running'].includes(card.status) && (
        <PrototypeProgress
          key={card.turnId}
          phase={card.phase}
          queued={card.status === 'queued'}
          disconnected={disconnected}
        />
      )}

      <PrototypeMetrics
        jobId={card.jobId}
        conversationId={conversationId}
        turnId={card.turnId}
        status={card.status}
        revision={card.revision}
      />

      {card.waitingReason && (
        <p className="mt-3 text-sm text-text-primary">
          {card.waitingReason === 'clarification' ? 'Нужно уточнение' : 'Нужно подтвердить план'}
        </p>
      )}
      {card.status === 'review' && (
        <p className="mt-3 text-sm text-text-primary">
          Это рабочая версия. Можно добавить требования и продолжить правки в чате. Завершайте
          прототип, когда результат вас устраивает.
        </p>
      )}
      {card.failure && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-red-500/10 p-2 text-sm text-red-700 dark:text-red-300"
        >
          {activityLabels[card.failure.message] ?? card.failure.message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      )}

      {card.activity.length > 0 && (
        <ol className="mt-3 max-h-28 space-y-1 overflow-auto text-xs text-text-secondary">
          {card.activity.slice(-5).map((item) => (
            <li key={item.id}>{activityMessage(item)}</li>
          ))}
        </ol>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {card.actions.approve && (
          <Button disabled={!!busy} onClick={() => runAction('approve')}>
            Подтвердить план
          </Button>
        )}
        {card.actions.retry && (
          <Button disabled={!!busy} onClick={() => runAction('retry')}>
            <RotateCcw className="mr-1 size-4" />
            Повторить
          </Button>
        )}
        {card.status === 'review' && card.actions.reply && card.promptMessageId && (
          <>
            <Button
              disabled={!!busy}
              onClick={() => {
                setPrototypeMode(true);
                document.querySelector<HTMLTextAreaElement>('[data-testid="text-input"]')?.focus();
              }}
            >
              Добавить требования
            </Button>
            {card.actions.finalize && (
              <Button variant="outline" disabled={!!busy} onClick={() => runAction('finalize')}>
                Завершить выполнение
              </Button>
            )}
          </>
        )}
        {card.actions.cancel && (
          <Button variant="outline" disabled={!!busy} onClick={() => runAction('cancel')}>
            <Square className="mr-1 size-4" />
            Отменить
          </Button>
        )}
        {card.previewAvailable && (
          <Button
            variant="outline"
            onClick={() => {
              setPrototypePreview({
                jobId: card.jobId,
                conversationId,
                htmlDigest: card.versions.at(-1)?.htmlDigest,
              });
              setArtifactsVisible(true);
            }}
          >
            Открыть предпросмотр
          </Button>
        )}
        {card.previewAvailable && (
          <Button variant="outline" disabled={!!busy} onClick={() => download('html')}>
            <Download className="mr-1 size-4" />
            HTML
          </Button>
        )}
        {card.sourcesAvailable && (
          <Button variant="outline" disabled={!!busy} onClick={() => download('sources')}>
            <Download className="mr-1 size-4" />
            Исходники
          </Button>
        )}
      </div>

      {card.status === 'review' && !card.selectedVariant && (
        <div
          role="group"
          aria-label="Выбор варианта прототипа"
          className="mt-3 rounded-lg border border-border-light p-3"
        >
          <p className="mb-3 text-sm text-text-primary">
            Выберите дизайн один раз. Все следующие доработки сохранят выбранный вариант. Завершить
            выполнение можно отдельно, когда результат вас устроит.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!!busy} onClick={() => chooseVariant('A')}>
              Выбрать вариант A
            </Button>
            <Button disabled={!!busy} onClick={() => chooseVariant('B')}>
              Выбрать вариант B
            </Button>
          </div>
        </div>
      )}
      {card.selectedVariant && (
        <p className="mt-3 text-sm text-text-primary">
          Выбран вариант {card.selectedVariant}. Доработки применяются к нему.
        </p>
      )}

      {card.versions.length > 1 && (
        <details className="mt-3 text-xs text-text-secondary">
          <summary className="cursor-pointer rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            Предыдущие версии ({card.versions.length - 1})
          </summary>
          <ul className="mt-2 space-y-2">
            {card.versions.slice(0, -1).map((version, index) => (
              <li
                key={`${version.turnId}:${version.revision}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span>Версия {index + 1}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => download('html', version.revision)}
                >
                  HTML
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => download('sources', version.revision)}
                >
                  Исходники
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
