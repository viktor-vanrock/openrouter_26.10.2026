import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Code,
  Copy,
  FileImage,
  FileVideo,
  ImagePlus,
} from 'lucide-react';
import {
  Button,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  useToastContext,
} from '@librechat/client';
import type { GuideFull, GuideMedia } from './api';
import GuideFrame from './GuideFrame';
import { getErrorMessage } from './utils';
import { guideKeys, saveGuide, useGuide, useGuideMedia } from './api';

const GuideEditorMonaco = lazy(() => import('./GuideEditorMonaco'));

async function copySnippet(snippet: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(snippet);
    return;
  }
  const field = document.createElement('textarea');
  field.value = snippet;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Не удалось скопировать код');
}

function MediaPickerCard({
  item,
  copied,
  onCopy,
}: {
  item: GuideMedia;
  copied: boolean;
  onCopy: (item: GuideMedia) => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.url]);

  return (
    <article className="w-56 shrink-0 overflow-hidden rounded-xl border border-border-light bg-surface-primary shadow-sm">
      <div className="flex h-32 items-center justify-center bg-slate-100">
        {failed || !item.url ? (
          <div className="flex flex-col items-center gap-1 text-center text-xs text-text-secondary">
            {item.kind === 'image' ? <FileImage size={28} /> : <FileVideo size={28} />}
            <span>Превью недоступно</span>
          </div>
        ) : item.kind === 'image' ? (
          <img
            src={item.url}
            alt={item.name}
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <video
            src={item.url}
            muted
            preload="metadata"
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <div className="space-y-2 p-3">
        <p className="truncate text-sm font-medium text-text-primary" title={item.name}>
          {item.name}
        </p>
        <p className="text-xs text-text-secondary">
          {item.kind === 'image' ? 'Картинка' : 'Видео'}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full gap-2"
          onClick={() => onCopy(item)}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? 'Скопировано' : 'Скопировать код'}
        </Button>
      </div>
    </article>
  );
}

class MonacoErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-slate-900 p-4 text-center text-slate-200">
          <span>Редактор не загрузился. Обновите страницу (Ctrl+F5)</span>
          <Button type="button" variant="outline" onClick={() => window.location.reload()}>
            Обновить
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

function GuideEditorInner({
  guide,
  initialHtml,
}: {
  guide: GuideFull['guide'];
  initialHtml: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const {
    data: mediaLibrary,
    isLoading: mediaLoading,
    isError: mediaError,
    refetch: refetchMedia,
  } = useGuideMedia();
  const media = Object.fromEntries(
    (mediaLibrary?.media ?? []).map((item) => [item.id, { url: item.url, kind: item.kind }]),
  );
  const pickerMedia = mediaLibrary?.media ?? [];
  const [code, setCode] = useState(initialHtml);
  const [saved, setSaved] = useState(initialHtml);
  const [preview, setPreview] = useState(initialHtml);
  const [saving, setSaving] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [monacoMounted, setMonacoMounted] = useState(false);
  const [mediaDialogOpen, setMediaDialogOpen] = useState(false);
  const [copiedMediaId, setCopiedMediaId] = useState<string | null>(null);
  const [mediaRailOverflow, setMediaRailOverflow] = useState(false);
  const initialized = useRef(false);
  const saveInFlight = useRef(false);
  const mediaRailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mediaDialogOpen) return;
    const rail = mediaRailRef.current;
    if (!rail) return;
    const update = () => setMediaRailOverflow(rail.scrollWidth > rail.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [mediaDialogOpen, pickerMedia.length]);

  const copyMedia = async (item: GuideMedia) => {
    try {
      await copySnippet(item.snippet);
      setCopiedMediaId(item.id);
      window.setTimeout(() => setCopiedMediaId(null), 2000);
      showToast({ status: 'success', message: 'Код скопирован' });
    } catch (error) {
      showToast({ status: 'error', message: getErrorMessage(error) });
    }
  };

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    const timeout = window.setTimeout(() => setPreview(code), 300);
    return () => window.clearTimeout(timeout);
  }, [code]);

  const dirty = code !== saved;
  const save = useCallback(async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      const result = await saveGuide(guide._id, code);
      setSaved(code);
      queryClient.setQueryData<GuideFull>(guideKeys.one(guide._id), (current) => ({
        guide: result.guide,
        html: code,
        media: current?.media,
        mediaOrigin: current?.mediaOrigin,
      }));
      await queryClient.invalidateQueries({ queryKey: guideKeys.list });
      await queryClient.invalidateQueries({ queryKey: guideKeys.one(guide._id) });
      showToast({ status: 'success', message: 'Черновик сохранён' });
    } catch (error) {
      showToast({ status: 'error', message: getErrorMessage(error) });
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [code, guide._id, queryClient, showToast]);

  useEffect(() => {
    if (!dirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [save]);

  const goBack = () => {
    if (dirty && !window.confirm('Есть несохранённые изменения. Выйти?')) return;
    navigate('/admin/guides');
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border-light px-3">
        <Button type="button" size="sm" variant="outline" onClick={goBack} className="gap-1">
          <ArrowLeft size={16} /> К списку
        </Button>
        <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{guide.title}</span>
        {dirty && <span className="text-xs text-amber-600">● не сохранено</span>}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setMonacoMounted(true);
            setCodeOpen((open) => !open);
          }}
          className="shrink-0 gap-1"
        >
          <Code size={16} /> {codeOpen ? 'Скрыть код' : 'Открыть код'}
        </Button>
        <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Сохранение…' : 'Сохранить'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setMediaDialogOpen(true)}
          className="shrink-0 gap-1"
        >
          <ImagePlus size={16} /> Выбрать картинку или видео
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <section
          className={`relative min-h-0 bg-white ${codeOpen ? 'flex-[2] border-b border-border-light' : 'flex-1'}`}
        >
          <GuideFrame
            html={preview}
            title="Предпросмотр"
            className="absolute inset-0 h-full w-full"
            media={media}
            mediaOrigin={mediaLibrary?.mediaOrigin}
          />
        </section>
        <section className={`relative min-h-0 bg-[#1e1e1e] ${codeOpen ? 'flex-1' : 'hidden'}`}>
          <div className="absolute inset-0">
            {monacoMounted && (
              <MonacoErrorBoundary>
                <Suspense
                  fallback={<div className="p-4 text-sm text-gray-300">Загрузка редактора…</div>}
                >
                  <GuideEditorMonaco value={code} onChange={setCode} onSave={() => void save()} />
                </Suspense>
              </MonacoErrorBoundary>
            )}
          </div>
        </section>
      </div>
      <OGDialog open={mediaDialogOpen} onOpenChange={setMediaDialogOpen}>
        <OGDialogContent className="max-w-4xl">
          <OGDialogTitle>Выбрать картинку или видео</OGDialogTitle>
          <p className="text-sm text-text-secondary">
            Скопируйте код файла, откройте редактор и вставьте его в нужное место HTML.
          </p>
          {mediaLoading && !mediaLibrary && (
            <p className="text-sm text-text-secondary">Загрузка файлов…</p>
          )}
          {mediaError && !mediaLibrary && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <span>Не удалось загрузить файлы.</span>
              <Button type="button" variant="outline" onClick={() => void refetchMedia()}>
                Повторить
              </Button>
            </div>
          )}
          <div className="relative min-w-0">
            {mediaRailOverflow && (
              <button
                type="button"
                onClick={() => mediaRailRef.current?.scrollBy({ left: -240, behavior: 'smooth' })}
                aria-label="Предыдущие файлы"
                className="absolute -left-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border-light bg-surface-primary text-text-primary shadow-md hover:bg-surface-secondary"
              >
                <ChevronLeft size={25} />
              </button>
            )}
            <div ref={mediaRailRef} className="flex min-w-0 gap-4 overflow-hidden px-1 py-2">
              {pickerMedia.length ? (
                pickerMedia.map((item) => (
                  <MediaPickerCard
                    key={item.id}
                    item={item}
                    copied={copiedMediaId === item.id}
                    onCopy={(media) => void copyMedia(media)}
                  />
                ))
              ) : (
                <p className="w-full py-10 text-center text-sm text-text-secondary">
                  Файлов пока нет
                </p>
              )}
            </div>
            {mediaRailOverflow && (
              <button
                type="button"
                onClick={() => mediaRailRef.current?.scrollBy({ left: 240, behavior: 'smooth' })}
                aria-label="Следующие файлы"
                className="absolute -right-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border-light bg-surface-primary text-text-primary shadow-md hover:bg-surface-secondary"
              >
                <ChevronRight size={25} />
              </button>
            )}
          </div>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
}

export default function GuideEditor() {
  const { id } = useParams();
  const { data, isLoading, isError } = useGuide(id);

  if (isLoading) return <div className="p-6">Загрузка…</div>;
  if (isError || !data) return <div className="p-6">Страница не найдена</div>;

  return <GuideEditorInner key={data.guide._id} guide={data.guide} initialHtml={data.html} />;
}
