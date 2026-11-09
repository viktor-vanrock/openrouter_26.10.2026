import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone } from 'lucide-react';
import { Button, OGDialog, OGDialogContent, OGDialogTitle } from '@librechat/client';
import {
  createRelease,
  deleteRelease,
  fetchAdminReleases,
  publishRelease,
  releaseErrorMessage,
  unpublishRelease,
  updateRelease,
  type AdminRelease,
} from './api';

const dateTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' });

function ReleaseFields({
  title,
  text,
  onTitle,
  onText,
}: {
  title: string;
  text: string;
  onTitle: (value: string) => void;
  onText: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      <label className="block text-sm font-medium text-text-primary">
        Заголовок <span className="font-normal text-text-secondary">(необязательно)</span>
        <input
          value={title}
          onChange={(event) => onTitle(event.target.value)}
          maxLength={120}
          className="mt-1 w-full rounded-lg border border-border-light bg-surface-primary px-3 py-2 text-text-primary"
          placeholder="Версия или короткая тема"
        />
      </label>
      <label className="block text-sm font-medium text-text-primary">
        Что нового
        <textarea
          value={text}
          onChange={(event) => onText(event.target.value)}
          maxLength={10000}
          rows={6}
          className="mt-1 w-full resize-y rounded-lg border border-border-light bg-surface-primary px-3 py-2 font-normal text-text-primary"
          placeholder="Расскажите, что изменилось на сайте"
        />
        <span className="mt-1 block text-right text-xs font-normal text-text-secondary">
          {text.length}/10000
        </span>
      </label>
    </div>
  );
}

function ReleaseCard({
  release,
  onEdit,
  onDelete,
  onPublish,
  onUnpublish,
}: {
  release: AdminRelease;
  onEdit: () => void;
  onDelete: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = release.text.split('\n').length > 6 || release.text.length > 600;
  return (
    <article className="rounded-2xl border border-border-light bg-surface-primary p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
        <time dateTime={release.isPublished ? release.publishedAt! : release.createdAt}>
          {dateTime.format(
            new Date(release.isPublished ? release.publishedAt! : release.createdAt),
          )}
        </time>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${release.isPublished ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100'}`}
        >
          {release.isPublished ? 'Опубликован' : 'Черновик'}
        </span>
      </div>
      {release.title && (
        <h3 className="mt-3 text-lg font-semibold text-text-primary">{release.title}</h3>
      )}
      <p
        className={`mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-text-primary ${!expanded ? 'line-clamp-6' : ''}`}
      >
        {release.text}
      </p>
      {long && (
        <button
          type="button"
          className="mt-1 text-sm text-blue-600 hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Свернуть' : 'Показать полностью'}
        </button>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onEdit}>
          Редактировать
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={release.isPublished ? onUnpublish : onPublish}
        >
          {release.isPublished ? 'Снять с публикации' : 'Опубликовать'}
        </Button>
        <Button type="button" size="sm" variant="destructive" onClick={onDelete}>
          Удалить
        </Button>
      </div>
    </article>
  );
}

export default function AdminReleases() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<AdminRelease | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editText, setEditText] = useState('');
  const [pending, setPending] = useState<null | {
    action: 'publish-new' | 'publish' | 'unpublish' | 'delete';
    release?: AdminRelease;
  }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sentinel = useRef<HTMLDivElement>(null);
  const nextPagePending = useRef(false);
  const list = useInfiniteQuery({
    queryKey: ['releases', 'admin'],
    queryFn: ({ pageParam }) => fetchAdminReleases(pageParam as string | undefined),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const releases = list.data?.pages.flatMap((page) => page.items) ?? [];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (!hasNextPage || !sentinel.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isFetchingNextPage && !nextPagePending.current) {
          nextPagePending.current = true;
          void fetchNextPage().finally(() => {
            nextPagePending.current = false;
          });
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['releases'] });
  const saveNew = async (publish: boolean) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    let createdId: string | null = null;
    try {
      const created = await createRelease({ title, text });
      createdId = created._id;
      setTitle('');
      setText('');
      if (publish) await publishRelease(created._id);
      setPending(null);
      await refresh();
    } catch (caught) {
      setError(
        publish && createdId
          ? `Черновик сохранён, но опубликовать его не удалось: ${releaseErrorMessage(caught)}. Найдите его в списке ниже и повторите публикацию.`
          : releaseErrorMessage(caught),
      );
      setPending(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const runAction = async () => {
    if (!pending?.release || busy) return;
    setBusy(true);
    setError('');
    try {
      if (pending.action === 'publish') await publishRelease(pending.release._id);
      if (pending.action === 'unpublish') await unpublishRelease(pending.release._id);
      if (pending.action === 'delete') await deleteRelease(pending.release._id);
      setPending(null);
      await refresh();
    } catch (caught) {
      setError(releaseErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const openEdit = (release: AdminRelease) => {
    setEditing(release);
    setEditTitle(release.title);
    setEditText(release.text);
    setError('');
  };
  const closeEdit = () => {
    if (
      editing &&
      (editTitle !== editing.title || editText !== editing.text) &&
      !window.confirm('Есть несохранённые изменения. Закрыть?')
    )
      return;
    setEditing(null);
  };
  const saveEdit = async () => {
    if (!editing || !editText.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await updateRelease(editing._id, { title: editTitle, text: editText });
      setEditing(null);
      await refresh();
    } catch (caught) {
      setError(releaseErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-primary p-6 md:p-9">
      <div className="mx-auto max-w-4xl space-y-8">
        <header className="flex items-center gap-3">
          <Megaphone className="h-7 w-7 text-text-primary" />
          <h1 className="text-3xl font-semibold text-text-primary">Релизы</h1>
        </header>
        <section className="rounded-2xl border border-border-light bg-surface-primary p-6 shadow-sm">
          <h2 className="mb-5 text-xl font-semibold text-text-primary">Новый релиз</h2>
          <ReleaseFields title={title} text={text} onTitle={setTitle} onText={setText} />
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={!text.trim() || busy}
              onClick={() => void saveNew(false)}
            >
              Сохранить черновик
            </Button>
            <Button
              type="button"
              disabled={!text.trim() || busy}
              onClick={() => setPending({ action: 'publish-new' })}
            >
              Опубликовать
            </Button>
          </div>
        </section>
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <section>
          <h2 className="mb-4 text-xl font-semibold text-text-primary">Прошлые релизы</h2>
          {list.isLoading && <p className="text-sm text-text-secondary">Загрузка релизов…</p>}
          {list.isError && (
            <div className="text-sm text-red-600">
              Не удалось загрузить релизы.{' '}
              <button type="button" className="underline" onClick={() => void list.refetch()}>
                Повторить
              </button>
            </div>
          )}
          {!list.isLoading && !releases.length && !list.isError && (
            <p className="text-sm text-text-secondary">Релизов пока нет</p>
          )}
          <div className="space-y-4">
            {releases.map((release) => (
              <ReleaseCard
                key={release._id}
                release={release}
                onEdit={() => openEdit(release)}
                onDelete={() => setPending({ action: 'delete', release })}
                onPublish={() => setPending({ action: 'publish', release })}
                onUnpublish={() => setPending({ action: 'unpublish', release })}
              />
            ))}
          </div>
          <div ref={sentinel} className="h-1" />
          {isFetchingNextPage && (
            <p className="py-3 text-center text-sm text-text-secondary">Загрузка…</p>
          )}
          {!hasNextPage && releases.length > 0 && (
            <p className="py-3 text-center text-sm text-text-secondary">Больше нет релизов</p>
          )}
        </section>
      </div>
      <OGDialog open={Boolean(pending)} onOpenChange={(open) => !open && setPending(null)}>
        <OGDialogContent className="max-w-md">
          <OGDialogTitle>
            {pending?.action === 'delete'
              ? 'Удалить релиз?'
              : pending?.action === 'unpublish'
                ? 'Снять с публикации?'
                : 'Опубликовать релиз?'}
          </OGDialogTitle>
          <p className="text-sm text-text-secondary">
            {pending?.action === 'delete'
              ? 'Он пропадёт у всех пользователей.'
              : pending?.action === 'unpublish'
                ? 'Релиз перестанет отображаться у пользователей.'
                : 'Вы действительно хотите опубликовать релиз? Пользователи увидят его сразу.'}
          </p>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setPending(null)}>
              Отмена
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void (pending?.action === 'publish-new' ? saveNew(true) : runAction())}
            >
              Подтвердить
            </Button>
          </div>
        </OGDialogContent>
      </OGDialog>
      <OGDialog open={Boolean(editing)} onOpenChange={(open) => !open && closeEdit()}>
        <OGDialogContent className="max-w-2xl">
          <OGDialogTitle>Редактировать релиз</OGDialogTitle>
          <ReleaseFields
            title={editTitle}
            text={editText}
            onTitle={setEditTitle}
            onText={setEditText}
          />
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={closeEdit}>
              Отмена
            </Button>
            <Button
              type="button"
              disabled={!editText.trim() || busy}
              onClick={() => void saveEdit()}
            >
              Сохранить
            </Button>
          </div>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}
