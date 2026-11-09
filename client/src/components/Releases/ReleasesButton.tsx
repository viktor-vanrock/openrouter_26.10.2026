import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone } from 'lucide-react';
import { Button, OGDialog, OGDialogContent, OGDialogTitle } from '@librechat/client';
import {
  getReleases,
  getUnreadReleases,
  markReleasesSeen,
  releaseKeys,
  useReleasesStatus,
  type ReleaseItem,
  type UnreadResponse,
} from './api';

const dayFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { timeStyle: 'short' });

export default function ReleasesButton({
  compact = false,
  inMenu = false,
}: {
  compact?: boolean;
  inMenu?: boolean;
}) {
  const queryClient = useQueryClient();
  const status = useReleasesStatus();
  const unread = status.data?.unreadCount ?? 0;
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<UnreadResponse | null>(null);
  const [unreadError, setUnreadError] = useState(false);
  const [seenError, setSeenError] = useState(false);
  const [retrySeenUpTo, setRetrySeenUpTo] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [modalUnread, setModalUnread] = useState<Set<string>>(new Set());
  const unreadCutoffRef = useRef<string | null>(null);
  const [unreadAtOpen, setUnreadAtOpen] = useState(false);
  const [modalSeenSent, setModalSeenSent] = useState(false);
  const [searchPages, setSearchPages] = useState(0);
  const [popoverPosition, setPopoverPosition] = useState({ top: 0, left: 0 });
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const modalBodyRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const nextPagePending = useRef(false);
  const unreadRequestRef = useRef(0);
  const list = useInfiniteQuery({
    queryKey: releaseKeys.list,
    queryFn: ({ pageParam }) => getReleases(pageParam as string | undefined),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: modalOpen,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  const markSeen = async (date: string) => {
    try {
      const result = await markReleasesSeen(date);
      setSeenError(false);
      setRetrySeenUpTo(null);
      queryClient.setQueryData(
        releaseKeys.status,
        (current: { unreadCount: number; latestPublishedAt: string | null } | undefined) =>
          current ? { ...current, unreadCount: result.unreadCount } : current,
      );
      await queryClient.invalidateQueries({ queryKey: releaseKeys.status });
    } catch {
      setSeenError(true);
      setRetrySeenUpTo(date);
    }
  };

  const openModal = (id: string | null = null) => {
    unreadRequestRef.current += 1;
    queryClient.removeQueries({ queryKey: releaseKeys.list });
    setUnreadAtOpen(popoverOpen && Boolean(snapshot?.items[0]));
    setTargetId(id);
    setSearchPages(0);
    setModalSeenSent(false);
    unreadCutoffRef.current = popoverOpen && snapshot?.items[0] ? snapshot.lastSeenAt : null;
    setModalUnread(new Set(popoverOpen ? (snapshot?.items.map((item) => item.id) ?? []) : []));
    setPopoverOpen(false);
    setModalOpen(true);
  };

  const clickButton = async () => {
    if (!unread) return openModal();
    const requestId = ++unreadRequestRef.current;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setPopoverPosition({
        top: inMenu ? rect.top - 8 : compact ? rect.top : rect.bottom + 8,
        left: inMenu
          ? Math.max(8, rect.left)
          : compact
            ? rect.right + 8
            : Math.max(8, rect.right - 320),
      });
    }
    setSnapshot(null);
    setUnreadError(false);
    setSeenError(false);
    setPopoverOpen((open) => !open);
    if (popoverOpen) return;
    try {
      const response = await getUnreadReleases();
      if (requestId !== unreadRequestRef.current) return;
      setSnapshot(response);
      if (response.items[0]) void markSeen(response.items[0].publishedAt);
    } catch {
      if (requestId === unreadRequestRef.current) setUnreadError(true);
    }
  };

  useEffect(() => {
    if (!popoverOpen) return;
    const close = (event: MouseEvent) => {
      if (
        !popoverRef.current?.contains(event.target as Node) &&
        !buttonRef.current?.contains(event.target as Node)
      ) {
        unreadRequestRef.current += 1;
        setPopoverOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        unreadRequestRef.current += 1;
        setPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [popoverOpen]);

  useEffect(() => {
    if (!modalOpen || modalSeenSent || !list.data?.pages[0]) return;
    const first = list.data.pages[0].items;
    if (!unreadAtOpen) unreadCutoffRef.current = list.data.pages[0].lastSeenAt;
    if (first[0] && first.some((item) => item.isUnread) && !unreadAtOpen)
      void markSeen(first[0].publishedAt);
    setModalSeenSent(true);
  }, [modalOpen, modalSeenSent, list.data, unreadAtOpen]);

  useEffect(() => {
    if (!modalOpen || !list.data?.pages.length || !unreadCutoffRef.current) return;
    const next = new Set<string>();
    for (const page of list.data.pages) {
      for (const item of page.items) {
        if (item.publishedAt > unreadCutoffRef.current) next.add(item.id);
      }
    }
    setModalUnread(next);
  }, [modalOpen, list.data, modalSeenSent]);

  useEffect(() => {
    if (!modalOpen || !list.hasNextPage || !sentinelRef.current || !modalBodyRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !list.isFetchingNextPage && !nextPagePending.current) {
          nextPagePending.current = true;
          void list.fetchNextPage().finally(() => {
            nextPagePending.current = false;
          });
        }
      },
      { root: modalBodyRef.current, rootMargin: '200px' },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [modalOpen, list.hasNextPage, list.isFetchingNextPage, list.fetchNextPage, items.length]);

  useEffect(() => {
    if (!modalOpen || !targetId) return;
    const node = document.getElementById(`release-${targetId}`);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightId(targetId);
      window.setTimeout(() => setHighlightId(null), 2000);
      setTargetId(null);
    } else if (list.hasNextPage && !list.isFetchingNextPage && searchPages < 5) {
      setSearchPages((count) => count + 1);
      void list.fetchNextPage();
    }
  }, [modalOpen, targetId, items.length, list.hasNextPage, list.isFetchingNextPage, searchPages]);

  return (
    <div className={inMenu ? 'w-full' : 'relative shrink-0'}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => void clickButton()}
        aria-label={unread ? `Что нового, есть непрочитанные: ${unread}` : 'Что нового'}
        aria-expanded={popoverOpen || modalOpen}
        className={
          inMenu
            ? 'flex h-[50px] w-full items-center text-left text-text-primary'
            : `relative inline-flex h-9 items-center justify-center gap-2 rounded-[30px] border text-sm font-semibold transition-colors ${compact ? 'w-9 p-0' : 'w-9 p-0 min-[1200px]:w-auto min-[1200px]:px-3'} ${unread ? 'guide-button-unvisited attention-button-shadow border-red-700 bg-red-700 text-white hover:bg-red-800' : 'border-border-light bg-surface-primary text-text-primary hover:bg-surface-hover'}`
        }
      >
        {!inMenu && <Megaphone size={16} aria-hidden="true" />}
        {inMenu ? (
          <span>Что нового{unread > 0 ? ` (${unread > 99 ? '99+' : unread})` : ''}</span>
        ) : (
          !compact && <span className="hidden min-[1200px]:inline">Что нового</span>
        )}
        {unread > 0 && !inMenu && (
          <span
            className={`${compact ? 'absolute right-0 top-0 min-w-4' : inMenu ? '' : 'max-[1199px]:absolute max-[1199px]:right-0 max-[1199px]:top-0 max-[1199px]:min-w-4'} rounded-full bg-white px-1 text-xs font-bold text-red-700`}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {popoverOpen &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Непрочитанные релизы"
            style={popoverPosition}
            className={`fixed z-[140] max-h-[65vh] w-80 max-w-[90vw] overflow-y-auto rounded-xl border border-border-light bg-surface-primary p-4 text-text-primary shadow-xl ${inMenu ? '-translate-y-full' : ''}`}
          >
            <h3 className="font-semibold">Что нового</h3>
            {!snapshot && !unreadError && (
              <p className="mt-3 text-sm text-text-secondary">Загрузка…</p>
            )}
            {unreadError && (
              <p role="alert" className="mt-3 text-sm text-red-600">
                Не удалось загрузить новости. Закройте окно и попробуйте снова.
              </p>
            )}
            {seenError && (
              <div role="alert" className="mt-3 text-sm text-red-600">
                Не удалось отметить новости прочитанными.{' '}
                {retrySeenUpTo && (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void markSeen(retrySeenUpTo)}
                  >
                    Повторить
                  </button>
                )}
              </div>
            )}
            {snapshot?.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="mt-2 block w-full rounded-lg p-2 text-left hover:bg-surface-hover"
                onClick={() => openModal(item.id)}
              >
                <span className="block text-xs text-text-secondary">
                  {dayFormat.format(new Date(item.publishedAt))}
                </span>
                {item.title && <strong className="block text-sm">{item.title}</strong>}
                <span className="block text-sm">
                  {item.text.slice(0, 120)}
                  {item.text.length > 120 ? '…' : ''}
                </span>
              </button>
            ))}
            {snapshot && snapshot.unreadCount > snapshot.items.length && (
              <p className="mt-2 text-xs text-text-secondary">
                Ещё {snapshot.unreadCount - snapshot.items.length}
              </p>
            )}
            <button
              type="button"
              className="mt-3 text-sm font-medium text-blue-600 hover:underline"
              onClick={() => openModal()}
            >
              Показать все
            </button>
          </div>,
          document.body,
        )}
      <OGDialog open={modalOpen} onOpenChange={setModalOpen}>
        <OGDialogContent
          className="releases-dialog max-w-2xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            modalBodyRef.current?.focus({ preventScroll: true });
          }}
        >
          <OGDialogTitle>Что нового</OGDialogTitle>
          <div
            ref={modalBodyRef}
            tabIndex={-1}
            className="max-h-[70vh] space-y-5 overflow-y-auto pr-2 focus:outline-none"
          >
            {seenError && (
              <div role="alert" className="text-sm text-red-600">
                Не удалось отметить новости прочитанными.{' '}
                {retrySeenUpTo && (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void markSeen(retrySeenUpTo)}
                  >
                    Повторить
                  </button>
                )}
              </div>
            )}
            {list.isLoading && <p className="text-sm text-text-secondary">Загрузка…</p>}
            {list.isError && (
              <div className="text-sm text-red-600">
                Не удалось загрузить релизы.{' '}
                <Button type="button" variant="outline" onClick={() => void list.refetch()}>
                  Повторить
                </Button>
              </div>
            )}
            {!list.isLoading && !list.isError && !items.length && (
              <p className="text-sm text-text-secondary">Пока нет релизов</p>
            )}
            {items.map((item: ReleaseItem, index) => {
              const day = dayFormat.format(new Date(item.publishedAt));
              const previous = index
                ? dayFormat.format(new Date(items[index - 1].publishedAt))
                : null;
              return (
                <div key={item.id}>
                  {day !== previous && (
                    <h3 className="mb-2 border-b border-border-light pb-1 font-semibold text-text-primary">
                      {day}
                    </h3>
                  )}
                  <article
                    id={`release-${item.id}`}
                    className={`rounded-xl p-3 transition-colors ${highlightId === item.id ? 'bg-amber-100 dark:bg-amber-900' : 'bg-surface-secondary'}`}
                  >
                    <div className="flex items-center gap-2 text-xs text-text-secondary">
                      <time dateTime={item.publishedAt}>
                        {timeFormat.format(new Date(item.publishedAt))}
                      </time>
                      {modalUnread.has(item.id) && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700">
                          Новое
                        </span>
                      )}
                    </div>
                    {item.title && (
                      <h4 className="mt-1 font-semibold text-text-primary">{item.title}</h4>
                    )}
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text-primary">
                      {item.text}
                    </p>
                  </article>
                </div>
              );
            })}
            <div ref={sentinelRef} className="h-1" />
            {list.isFetchingNextPage && (
              <p className="text-center text-sm text-text-secondary">Загрузка…</p>
            )}
            {!list.hasNextPage && items.length > 0 && (
              <p className="text-center text-sm text-text-secondary">Больше нет релизов</p>
            )}
          </div>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}
