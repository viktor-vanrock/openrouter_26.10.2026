import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Eye, FileText, Trash2, Upload } from 'lucide-react';
import {
  Button,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  useToastContext,
} from '@librechat/client';
import GuideFrame from './GuideFrame';
import GuideMediaLibrary from './GuideMediaLibrary';
import { getErrorMessage } from './utils';
import {
  deleteGuide,
  fetchPublishedGuide,
  type GuideMediaMap,
  type GuideMeta,
  guideKeys,
  publishGuide,
  uploadGuide,
  useGuidePreview,
  useGuideMedia,
  useGuides,
} from './api';

function GuideCard({
  guide,
  selected,
  onSelect,
  onOpen,
  onDelete,
  media,
  mediaOrigin,
}: {
  guide: GuideMeta;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onDelete: () => void;
  media: GuideMediaMap;
  mediaOrigin?: string;
}) {
  const { data, isLoading, isError, refetch } = useGuidePreview(guide._id);

  return (
    <article className="group relative w-[333px] flex-none snap-start">
      <button
        type="button"
        onClick={onSelect}
        className={`relative h-[208px] w-[333px] overflow-hidden rounded-2xl border bg-white text-left shadow-sm transition-all duration-200 hover:-translate-y-1 hover:border-blue-400 hover:shadow-xl dark:bg-surface-secondary ${selected ? 'border-blue-500 ring-2 ring-blue-500/30' : 'border-border-light'}`}
      >
        {isLoading && (
          <div className="absolute inset-0 animate-pulse bg-slate-200 dark:bg-slate-700" />
        )}
        {isError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-100 px-4 text-center text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <span>Не удалось загрузить превью</span>
            <span
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation();
                void refetch();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') void refetch();
              }}
              className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              Повторить
            </span>
          </div>
        )}
        {data && (
          <div
            className="pointer-events-none absolute left-0 top-0 origin-top-left"
            style={{
              width: 1280,
              height: 800,
              transform: 'scale(0.26)',
              transformOrigin: 'top left',
            }}
          >
            <GuideFrame
              html={data.html}
              title={guide.title}
              media={media}
              mediaOrigin={mediaOrigin}
              preview
              className="h-full w-full"
            />
          </div>
        )}
        <span
          className={`absolute left-3 top-3 rounded-full px-3 py-1 text-xs font-semibold shadow-sm ${
            guide.isPublished ? 'bg-emerald-600 text-white' : 'bg-slate-800/90 text-white'
          }`}
        >
          {guide.isPublished ? 'Опубликовано' : 'Черновик'}
        </span>
        <span className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-black/70 to-transparent" />
        <span className="absolute bottom-3 left-4 right-4 truncate font-medium text-white">
          {guide.title}
        </span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        aria-label={`Открыть превью «${guide.title}»`}
        className="absolute right-16 top-3 z-10 flex size-11 items-center justify-center rounded-full border-2 border-white bg-slate-700 text-white opacity-0 shadow-lg transition-all hover:scale-110 hover:bg-slate-900 focus:opacity-100 group-hover:opacity-100"
      >
        <Eye className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        aria-label={`Удалить «${guide.title}»`}
        className="absolute right-3 top-3 z-10 flex size-11 items-center justify-center rounded-full border-2 border-white bg-slate-700 text-white opacity-0 shadow-lg transition-all hover:scale-110 hover:bg-slate-900 focus:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={2.8} />
      </button>
    </article>
  );
}

function CurrentGuide({
  guide,
  onOpen,
  onDelete,
  media,
  mediaOrigin,
}: {
  guide: GuideMeta | null;
  onOpen: () => void;
  onDelete: () => void;
  media: GuideMediaMap;
  mediaOrigin?: string;
}) {
  const preview = useGuidePreview(guide?._id);
  const published = useQuery({
    queryKey: ['publishedGuide'],
    queryFn: fetchPublishedGuide,
    enabled: Boolean(guide?.isPublished),
    staleTime: 30_000,
  });
  const current = guide?.isPublished ? published : preview;

  if (!guide) {
    return (
      <div className="flex h-[312px] w-[500px] items-center justify-center rounded-2xl border-2 border-dashed border-border-medium bg-[rgb(248_248_248)] text-center text-[18px] font-bold text-black">
        Страница ещё не выбрана
      </div>
    );
  }

  return (
    <div className="group relative h-[312px] w-[500px] overflow-hidden rounded-2xl border-2 border-blue-500 bg-white shadow-xl dark:bg-surface-secondary">
      {current.isLoading && (
        <div className="absolute inset-0 animate-pulse bg-slate-200 dark:bg-slate-700" />
      )}
      {current.isError && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-text-secondary">
          Не удалось загрузить превью
        </div>
      )}
      {current.data && (
        <div
          className="pointer-events-none absolute left-0 top-0 origin-top-left"
          style={{
            width: 1280,
            height: 800,
            transform: 'scale(0.39)',
            transformOrigin: 'top left',
          }}
        >
          <GuideFrame
            html={current.data.html}
            title={guide.title}
            media={current.data.media ?? media}
            mediaOrigin={current.data.mediaOrigin ?? mediaOrigin}
            preview
            className="h-full w-full"
          />
        </div>
      )}
      <span className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-black/70 to-transparent" />
      <span className="absolute bottom-4 left-5 right-5 truncate text-lg font-semibold text-white">
        {guide.title}
      </span>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Открыть превью «${guide.title}»`}
        className="absolute right-16 top-4 flex size-11 items-center justify-center rounded-full border-2 border-white bg-slate-700 text-white shadow-lg hover:bg-slate-900"
      >
        <Eye className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Удалить «${guide.title}»`}
        className="absolute right-4 top-4 flex size-11 items-center justify-center rounded-full border-2 border-white bg-slate-700 text-white shadow-lg hover:bg-slate-900"
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={2.8} />
      </button>
    </div>
  );
}

export default function AdminGuides() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const { data: guides = [], isLoading } = useGuides();
  const { data: mediaLibrary } = useGuideMedia();
  const media = Object.fromEntries(
    (mediaLibrary?.media ?? []).map((item) => [item.id, { url: item.url, kind: item.kind }]),
  );
  const [toDelete, setToDelete] = useState<GuideMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadHovered, setUploadHovered] = useState(false);
  const [showArrows, setShowArrows] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const selectedGuide = guides.find((guide) => guide._id === selectedId) ?? null;
  const publishedGuide = guides.find((guide) => guide.isPublished) ?? null;
  const currentGuide = selectedGuide ?? publishedGuide;
  const canPublish = Boolean(selectedGuide && !selectedGuide.isPublished);

  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;
    const updateArrows = () => setShowArrows(slider.scrollWidth > slider.clientWidth + 1);
    updateArrows();
    const observer = new ResizeObserver(updateArrows);
    observer.observe(slider);
    return () => observer.disconnect();
  }, [guides.length]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: guideKeys.list });
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await uploadGuide(file);
      queryClient.setQueryData(guideKeys.one(result.guide._id), result);
      queryClient.setQueryData<GuideMeta[]>(guideKeys.list, (current = []) => [
        result.guide,
        ...current.filter((guide) => guide._id !== result.guide._id),
      ]);
      await refresh();
      showToast({ status: 'success', message: 'HTML-страница загружена' });
    } catch (error) {
      showToast({ status: 'error', message: getErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      await deleteGuide(toDelete._id);
      if (selectedId === toDelete._id) setSelectedId(null);
      setToDelete(null);
      await refresh();
      showToast({ status: 'success', message: 'Страница удалена' });
    } catch (error) {
      showToast({ status: 'error', message: getErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const publishSelected = async () => {
    if (!selectedGuide) return;
    setBusy(true);
    try {
      await publishGuide(selectedGuide._id);
      await queryClient.invalidateQueries({ queryKey: guideKeys.list });
      await queryClient.invalidateQueries({ queryKey: ['publishedGuide'] });
      queryClient.removeQueries({ queryKey: guideKeys.one(selectedGuide._id) });
      showToast({ status: 'success', message: 'Страница стала активной' });
    } catch (error) {
      showToast({ status: 'error', message: getErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="to-surface-secondary/30 flex h-full flex-col overflow-auto bg-gradient-to-b from-surface-primary p-6 md:p-9">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-7">
          <h1 className="text-3xl font-semibold tracking-tight text-text-primary">
            Инструкция по работе с сайтом
          </h1>
          <p className="mt-2 text-text-secondary">
            Загрузите HTML-страницы и откройте нужную для просмотра.
          </p>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".html,.htm,text/html"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void upload(file);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          onMouseEnter={() => setUploadHovered(true)}
          onMouseLeave={() => setUploadHovered(false)}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void upload(event.dataTransfer.files?.[0]);
          }}
          style={{ backgroundColor: dragging || uploadHovered ? '#f3f3f3' : undefined }}
          className={`flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 transition-colors duration-200 ${
            dragging || uploadHovered
              ? 'scale-[1.01] border-slate-400'
              : 'border-slate-300 bg-slate-100 dark:border-slate-600 dark:bg-slate-800/60'
          } disabled:cursor-wait disabled:opacity-60`}
        >
          <span className="mb-4 flex size-14 items-center justify-center rounded-2xl border border-slate-300 bg-slate-200 text-slate-600 shadow-sm dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300">
            <FileText className="size-7" />
          </span>
          <span className="text-lg font-semibold text-text-primary">Перетащите HTML-файл сюда</span>
          <span className="mt-1 text-sm text-text-secondary">
            или нажмите, чтобы выбрать файл · до 2 МБ
          </span>
          <span className="mt-5 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100">
            <Upload className="size-4" /> Выбрать файл
          </span>
        </button>

        <section className="mt-10">
          <h2 className="mb-4 text-xl font-semibold text-text-primary">Опубликованная страница</h2>
          {selectedGuide && !selectedGuide.isPublished && (
            <p className="mb-4 text-center text-sm text-text-secondary">
              Показан выбранный черновик. Для пользователей он станет виден после публикации.
            </p>
          )}
          <div className="flex justify-center">
            <CurrentGuide
              guide={currentGuide}
              onOpen={() => currentGuide && navigate(`/admin/guides/${currentGuide._id}/edit`)}
              onDelete={() => currentGuide && setToDelete(currentGuide)}
              media={media}
              mediaOrigin={mediaLibrary?.mediaOrigin}
            />
          </div>
        </section>

        <div className="mt-10 flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold text-text-primary">Загруженные страницы</h2>
        </div>
        <div className="relative mt-5">
          {showArrows && guides.length > 0 && (
            <button
              type="button"
              onClick={() => sliderRef.current?.scrollBy({ left: -360, behavior: 'smooth' })}
              aria-label="Показать предыдущие страницы"
              className="absolute -left-5 top-24 z-20 flex h-12 w-12 items-center justify-center rounded-full border border-border-light bg-surface-primary text-text-primary shadow-lg hover:bg-surface-secondary"
            >
              <ChevronLeft className="h-[34px] w-[34px]" />
            </button>
          )}
          {showArrows && guides.length > 0 && (
            <button
              type="button"
              onClick={() => sliderRef.current?.scrollBy({ left: 360, behavior: 'smooth' })}
              aria-label="Показать следующие страницы"
              className="absolute -right-5 top-24 z-20 flex h-12 w-12 items-center justify-center rounded-full border border-border-light bg-surface-primary text-text-primary shadow-lg hover:bg-surface-secondary"
            >
              <ChevronRight className="h-[34px] w-[34px]" />
            </button>
          )}
          <div ref={sliderRef} className="flex w-full snap-x gap-5 overflow-hidden pb-6 pt-2">
            {isLoading && <p className="py-8 text-sm text-text-tertiary">Загрузка страниц…</p>}
            {!isLoading && guides.length === 0 && (
              <p className="py-8 text-sm text-text-tertiary">Пока нет страниц</p>
            )}
            {guides.map((guide) => (
              <GuideCard
                key={guide._id}
                guide={guide}
                selected={guide._id === selectedId}
                onSelect={() => setSelectedId(guide._id)}
                onOpen={() => navigate(`/admin/guides/${guide._id}/edit`)}
                onDelete={() => setToDelete(guide)}
                media={media}
                mediaOrigin={mediaLibrary?.mediaOrigin}
              />
            ))}
          </div>
        </div>
        <div className="mt-2 pt-5">
          <Button
            type="button"
            disabled={!canPublish || busy}
            onClick={() => void publishSelected()}
            className="h-11 rounded-[20px] bg-[hsl(107.31deg_100%_19.13%)] px-5 text-base hover:bg-[hsl(107.31deg_100%_15%)]"
          >
            Опубликовать
          </Button>
          {!selectedGuide && (
            <span className="ml-3 text-sm text-text-secondary">
              Выберите страницу для публикации
            </span>
          )}
          {selectedGuide?.isPublished && (
            <span className="ml-3 text-sm text-emerald-600">Эта страница уже активна</span>
          )}
          {selectedGuide && !selectedGuide.isPublished && (
            <Button
              type="button"
              variant="outline"
              className="ml-2 h-11 rounded-[20px] px-5 text-base"
              disabled={busy}
              onClick={() => setSelectedId(null)}
            >
              Отмена
            </Button>
          )}
        </div>
        <GuideMediaLibrary />
      </div>

      <OGDialog open={Boolean(toDelete)} onOpenChange={(open) => !open && setToDelete(null)}>
        <OGDialogContent className="max-w-md">
          <OGDialogTitle>Удалить страницу?</OGDialogTitle>
          <p className="text-sm text-text-secondary">
            «{toDelete?.title}» будет удалена без возможности восстановления.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setToDelete(null)}>
              Отмена
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void onDelete()}
            >
              Удалить
            </Button>
          </div>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}
