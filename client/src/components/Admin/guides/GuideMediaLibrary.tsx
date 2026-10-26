import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileImage,
  FileVideo,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  Button,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  useToastContext,
} from '@librechat/client';
import {
  deleteGuideMedia,
  guideKeys,
  type GuideMedia,
  uploadGuideMedia,
  useGuideMedia,
} from './api';
import { getErrorMessage } from './utils';
import { useQueryClient } from '@tanstack/react-query';

const imageMax = 5 * 1024 * 1024;
const videoMax = 200 * 1024 * 1024;
const demoColors = [
  ['#f59e0b', '#fcd34d'],
  ['#0f172a', '#64748b'],
  ['#2563eb', '#93c5fd'],
  ['#059669', '#6ee7b7'],
  ['#be185d', '#f9a8d4'],
  ['#7c3aed', '#c4b5fd'],
  ['#ea580c', '#fdba74'],
  ['#0891b2', '#67e8f9'],
  ['#475569', '#cbd5e1'],
  ['#dc2626', '#fca5a5'],
];

// Temporary images for checking the carousel layout while the media library is empty.
const demoMedia: GuideMedia[] = demoColors.map(([from, to], index) => {
  const number = String(index + 1).padStart(2, '0');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 288"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="512" height="288" fill="url(#g)"/><circle cx="390" cy="72" r="52" fill="white" opacity=".35"/><path d="M0 250 145 92 275 232 360 140 512 280v8H0Z" fill="white" opacity=".28"/><text x="28" y="255" fill="white" font-family="sans-serif" font-size="64" font-weight="700">${number}</text></svg>`;
  return {
    id: `demo-${number}`,
    kind: 'image',
    name: `Тестовая картинка ${number}`,
    size: 0,
    createdAt: '',
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    snippet: '',
  };
});

type UploadState = {
  id: string;
  name: string;
  progress: number;
  error?: string;
  done?: boolean;
  controller: AbortController;
};

function formatSize(size: number) {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} МБ`
    : `${Math.ceil(size / 1024)} КБ`;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const element = document.createElement('textarea');
  element.value = value;
  element.style.position = 'fixed';
  element.style.opacity = '0';
  document.body.append(element);
  element.select();
  const copied = document.execCommand('copy');
  element.remove();
  if (!copied) throw new Error('Не удалось скопировать код');
}

function MediaCard({
  media,
  onDelete,
  onRefresh,
  demo = false,
}: {
  media: GuideMedia;
  onDelete: (media: GuideMedia) => void;
  onRefresh: () => void;
  demo?: boolean;
}) {
  const { showToast } = useToastContext();
  const [copied, setCopied] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => setPreviewFailed(false), [media.url]);
  const copy = async () => {
    try {
      await copyText(media.snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      showToast({ status: 'success', message: 'Код скопирован' });
    } catch (error) {
      showToast({ status: 'error', message: getErrorMessage(error) });
    }
  };
  return (
    <article className="group relative w-64 flex-none overflow-hidden rounded-xl border border-border-light bg-surface-primary shadow-sm">
      <div className="flex h-36 items-center justify-center overflow-hidden bg-slate-100">
        {previewFailed || !media.url ? (
          <div className="flex flex-col items-center gap-2 px-3 text-center text-xs text-text-secondary">
            {media.kind === 'image' ? <FileImage size={26} /> : <FileVideo size={26} />}
            <span>Не удалось загрузить превью</span>
            <button
              type="button"
              onClick={() => {
                setPreviewFailed(false);
                onRefresh();
              }}
              className="rounded-md bg-slate-700 px-2 py-1 font-medium text-white hover:bg-slate-900"
            >
              Обновить ссылку
            </button>
          </div>
        ) : media.kind === 'image' ? (
          <a href={media.url} target="_blank" rel="noreferrer" className="h-full w-full">
            <img
              src={media.url}
              alt=""
              onError={() => setPreviewFailed(true)}
              className="h-full w-full object-cover"
            />
          </a>
        ) : (
          <video
            src={media.url}
            muted
            preload="metadata"
            onError={() => setPreviewFailed(true)}
            className="h-full w-full object-cover"
          />
        )}
      </div>
      <div className="p-3 pr-10">
        <p className="truncate text-sm font-medium text-text-primary" title={media.name}>
          {media.name}
        </p>
        <p className="mt-1 text-xs text-text-secondary">
          {demo
            ? 'Тестовое изображение'
            : `${formatSize(media.size)} · ${media.kind === 'image' ? 'Картинка' : 'Видео'}`}
        </p>
      </div>
      {!demo && (
        <>
          <button
            type="button"
            onClick={() => onDelete(media)}
            aria-label={`Удалить ${media.name}`}
            className="absolute right-2 top-2 rounded-full bg-slate-800/85 p-2 text-white hover:bg-slate-950"
          >
            <Trash2 size={15} />
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={`Скопировать код ${media.name}`}
            className="absolute bottom-2 right-2 rounded-full bg-slate-800 p-2 text-white hover:bg-slate-950"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </>
      )}
    </article>
  );
}

export default function GuideMediaLibrary() {
  const { data, isLoading, isError, error, isFetching, refetch } = useGuideMedia();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const input = useRef<HTMLInputElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const [showArrows, setShowArrows] = useState(false);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [selectionErrors, setSelectionErrors] = useState<string[]>([]);
  const [toDelete, setToDelete] = useState<GuideMedia | null>(null);
  const [usage, setUsage] = useState<Array<{ id: string; title: string }> | null>(null);
  const displayedMedia = data?.media ?? [];
  useEffect(() => {
    const slider = rail.current;
    if (!slider) return;
    const updateArrows = () =>
      setShowArrows(displayedMedia.length > 0 && slider.scrollWidth > slider.clientWidth + 1);
    updateArrows();
    const observer = new ResizeObserver(updateArrows);
    observer.observe(slider);
    return () => observer.disconnect();
  }, [displayedMedia.length]);
  const listError = getErrorMessage(error);
  const listErrorMessage =
    listError === 'Что-то пошло не так' && error instanceof Error ? error.message : listError;

  const addFiles = async (files: FileList | File[]) => {
    const selectedFiles = Array.from(files);
    setSelectionErrors([]);
    if (!selectedFiles.length) {
      setSelectionErrors(['Файлы не выбраны']);
      return;
    }
    for (const file of selectedFiles) {
      const image = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type);
      const video = ['video/mp4', 'video/webm'].includes(file.type);
      const max = image ? imageMax : video ? videoMax : 0;
      if (!max) {
        setSelectionErrors((current) => [
          ...current,
          `${file.name}: выберите PNG, JPEG, WebP, GIF, MP4 или WebM`,
        ]);
        continue;
      }
      if (file.size > max) {
        setSelectionErrors((current) => [
          ...current,
          `${file.name}: превышен лимит ${image ? 5 : 200} МБ`,
        ]);
        continue;
      }
      const controller = new AbortController();
      const upload = { id: crypto.randomUUID(), name: file.name, progress: 0, controller };
      setUploads((current) => [...current, upload]);
      try {
        const result = await uploadGuideMedia(file, controller.signal, (progress) =>
          setUploads((current) =>
            current.map((item) => (item.id === upload.id ? { ...item, progress } : item)),
          ),
        );
        if (!result.media?.id) {
          throw new Error('Сервер не вернул сведения о загруженном файле');
        }
        queryClient.setQueryData<{ media: GuideMedia[]; mediaOrigin?: string }>(
          guideKeys.media,
          (current) => ({
            media: [
              result.media,
              ...(current?.media ?? []).filter((item) => item.id !== result.media.id),
            ],
            mediaOrigin: result.mediaOrigin ?? current?.mediaOrigin,
          }),
        );
        void queryClient.invalidateQueries({ queryKey: guideKeys.media });
        setUploads((current) => current.filter((item) => item.id !== upload.id));
      } catch (error) {
        if (controller.signal.aborted) {
          setUploads((current) => current.filter((item) => item.id !== upload.id));
        } else {
          const message =
            getErrorMessage(error) === 'Что-то пошло не так' && error instanceof Error
              ? error.message
              : getErrorMessage(error);
          setUploads((current) =>
            current.map((item) =>
              item.id === upload.id ? { ...item, error: message, done: true } : item,
            ),
          );
        }
      }
    }
  };

  const refreshMedia = () => {
    void queryClient.refetchQueries({ queryKey: guideKeys.media });
  };

  const remove = async (force = false) => {
    if (!toDelete) return;
    try {
      await deleteGuideMedia(toDelete.id, force);
      setToDelete(null);
      setUsage(null);
      await queryClient.invalidateQueries({ queryKey: guideKeys.media });
      showToast({ status: 'success', message: 'Файл удалён' });
    } catch (error) {
      const response = error as {
        response?: { status?: number; data?: { pages?: Array<{ id: string; title: string }> } };
      };
      if (response.response?.status === 409) setUsage(response.response.data?.pages ?? []);
      else showToast({ status: 'error', message: getErrorMessage(error) });
    }
  };

  return (
    <section className="mt-12">
      <h2 className="text-xl font-semibold text-text-primary">Картинки и видео</h2>
      <input
        ref={input}
        className="hidden"
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.target.value = '';
          void addFiles(files);
        }}
      />
      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void addFiles(Array.from(event.dataTransfer.files));
        }}
        className="mt-4 rounded-2xl border-2 border-dashed border-slate-300 bg-[rgb(248_248_248)] p-8 text-center"
      >
        <FileImage className="mx-auto text-slate-500" size={34} />
        <p className="mt-3 font-medium text-text-primary">Перетащите картинки или видео сюда</p>
        <p className="mt-1 text-sm text-text-secondary">
          Картинки до 5 МБ (PNG, JPEG, WebP, GIF), видео до 200 МБ (MP4, WebM)
        </p>
        <Button type="button" className="mt-4 gap-2" onClick={() => input.current?.click()}>
          <Upload size={16} /> Выбрать файлы
        </Button>
      </div>
      {selectionErrors.length > 0 && (
        <div role="alert" className="mt-3 space-y-1 text-sm text-red-600">
          {selectionErrors.map((message, index) => (
            <p key={`${index}-${message}`}>{message}</p>
          ))}
        </div>
      )}
      {uploads.map((upload) => (
        <div key={upload.id} className="mt-3 rounded-lg border border-border-light p-3 text-sm">
          <div className="flex justify-between">
            <span className="truncate">{upload.name}</span>
            <button
              type="button"
              onClick={() =>
                upload.done
                  ? setUploads((current) => current.filter((item) => item.id !== upload.id))
                  : upload.controller.abort()
              }
              className="text-text-secondary"
            >
              {upload.done ? 'Закрыть' : 'Отменить'}
            </button>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-200">
            <div className="h-full bg-blue-600" style={{ width: `${upload.progress * 100}%` }} />
          </div>
          {upload.error && <p className="mt-1 text-red-600">{upload.error}</p>}
        </div>
      ))}
      {!isLoading && !isError && displayedMedia.length === 0 && (
        <p className="mt-5 text-center text-sm text-text-secondary">Файлов пока нет</p>
      )}
      {isLoading && !data && (
        <p className="mt-5 text-center text-sm text-text-secondary">Загрузка файлов…</p>
      )}
      {isError && !data && (
        <div className="mt-5 text-center text-sm text-red-600">
          <p>Не удалось загрузить список файлов: {listErrorMessage}</p>
          <Button type="button" variant="outline" className="mt-2" onClick={() => void refetch()}>
            Повторить
          </Button>
        </div>
      )}
      <h2 className="mt-8 text-xl font-semibold text-text-primary">Загруженные картинки и медиа</h2>
      <div className="relative mt-5">
        {showArrows && displayedMedia.length > 0 && (
          <button
            type="button"
            onClick={() => rail.current?.scrollBy({ left: -280, behavior: 'smooth' })}
            aria-label="Показать предыдущие медиафайлы"
            className="absolute -left-5 top-1/2 z-20 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-border-light bg-surface-primary text-text-primary shadow-lg hover:bg-surface-secondary"
          >
            <ChevronLeft className="h-[34px] w-[34px]" />
          </button>
        )}
        <div ref={rail} className="flex w-full snap-x gap-4 overflow-x-auto px-2 py-2">
          {displayedMedia.length
            ? displayedMedia.map((media) => (
                <MediaCard
                  key={media.id}
                  media={media}
                  onDelete={setToDelete}
                  onRefresh={refreshMedia}
                />
              ))
            : !isLoading && !isError && data && demoMedia.map((media) => (
                <MediaCard
                  key={media.id}
                  media={media}
                  onDelete={setToDelete}
                  onRefresh={refreshMedia}
                  demo
                />
              ))}
        </div>
        {showArrows && displayedMedia.length > 0 && (
          <button
            type="button"
            onClick={() => rail.current?.scrollBy({ left: 280, behavior: 'smooth' })}
            aria-label="Показать следующие медиафайлы"
            className="absolute -right-5 top-1/2 z-20 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-border-light bg-surface-primary text-text-primary shadow-lg hover:bg-surface-secondary"
          >
            <ChevronRight className="h-[34px] w-[34px]" />
          </button>
        )}
      </div>
      {isError && data && (
        <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
          <span>Не удалось обновить список файлов.</span>
          <button type="button" onClick={() => void refetch()} className="underline">
            Повторить
          </button>
        </div>
      )}
      {Boolean(data?.signingErrors) && (
        <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
          <span>Не удалось получить ссылки для {data?.signingErrors} файлов.</span>
          <button type="button" onClick={() => void refetch()} className="underline">
            Повторить
          </button>
        </div>
      )}
      {isFetching && data && !isError && (
        <p className="mt-2 text-xs text-text-secondary">Обновление списка…</p>
      )}
      <div className="mt-5 rounded-xl bg-surface-secondary p-4 text-sm leading-6 text-text-secondary">
        <p className="font-medium text-text-primary">Как добавить картинку или видео на страницу</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Загрузите файл выше.</li>
          <li>Нажмите значок копирования в правом нижнем углу карточки файла.</li>
          <li>
            Откройте страницу на редактирование, нажмите «Открыть код» и вставьте скопированный тег
            в HTML.
          </li>
          <li>Сохраните. Превью сразу покажет файл.</li>
        </ol>
      </div>
      <OGDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => {
          if (!open) {
            setToDelete(null);
            setUsage(null);
          }
        }}
      >
        <OGDialogContent className="max-w-md">
          <OGDialogTitle>{usage ? 'Файл используется' : 'Удалить файл?'}</OGDialogTitle>
          {usage ? (
            <div>
              <p className="text-sm text-text-secondary">
                Файл используется на страницах: {usage.map((page) => page.title).join(', ')}.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setToDelete(null);
                    setUsage(null);
                  }}
                >
                  Отмена
                </Button>
                <Button type="button" variant="destructive" onClick={() => void remove(true)}>
                  Удалить всё равно
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-sm text-text-secondary">
                «{toDelete?.name}» будет удалён без возможности восстановления.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setToDelete(null)}>
                  Отмена
                </Button>
                <Button type="button" variant="destructive" onClick={() => void remove()}>
                  Удалить
                </Button>
              </div>
            </div>
          )}
        </OGDialogContent>
      </OGDialog>
    </section>
  );
}
