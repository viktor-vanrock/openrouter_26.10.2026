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
import { ArrowLeft, Code, ImagePlus } from 'lucide-react';
import {
  Button,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  useToastContext,
} from '@librechat/client';
import type { GuideFull } from './api';
import GuideFrame from './GuideFrame';
import { getErrorMessage } from './utils';
import { guideKeys, saveGuide, useGuide, useGuideMedia } from './api';
import type { GuideEditorMonacoHandle } from './GuideEditorMonaco';

const GuideEditorMonaco = lazy(() => import('./GuideEditorMonaco'));

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

function GuideEditorInner({ guide, initialHtml }: { guide: GuideFull['guide']; initialHtml: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const { data: mediaLibrary } = useGuideMedia();
  const media = Object.fromEntries(
    (mediaLibrary?.media ?? []).map((item) => [item.id, { url: item.url, kind: item.kind }]),
  );
  const [code, setCode] = useState(initialHtml);
  const [saved, setSaved] = useState(initialHtml);
  const [preview, setPreview] = useState(initialHtml);
  const [saving, setSaving] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [monacoMounted, setMonacoMounted] = useState(false);
  const [mediaDialogOpen, setMediaDialogOpen] = useState(false);
  const initialized = useRef(false);
  const saveInFlight = useRef(false);
  const monacoRef = useRef<GuideEditorMonacoHandle>(null);

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
        <span className="truncate font-medium text-text-primary">{guide.title}</span>
        {dirty && <span className="text-xs text-amber-600">● не сохранено</span>}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!monacoMounted}
          onClick={() => setMediaDialogOpen(true)}
          className="gap-1"
        >
          <ImagePlus size={16} /> Вставить файл
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setMonacoMounted(true);
            setCodeOpen((open) => !open);
          }}
          className="ml-auto gap-1"
        >
          <Code size={16} /> {codeOpen ? 'Скрыть код' : 'Открыть код'}
        </Button>
        <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Сохранение…' : 'Сохранить'}
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
                  <GuideEditorMonaco
                    ref={monacoRef}
                    value={code}
                    onChange={setCode}
                    onSave={() => void save()}
                  />
                </Suspense>
              </MonacoErrorBoundary>
            )}
          </div>
        </section>
      </div>
      <OGDialog open={mediaDialogOpen} onOpenChange={setMediaDialogOpen}>
        <OGDialogContent className="max-w-lg">
          <OGDialogTitle>Вставить файл</OGDialogTitle>
          <div className="mt-3 max-h-80 space-y-2 overflow-y-auto">
            {mediaLibrary?.media.length ? (
              mediaLibrary.media.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  variant="outline"
                  className="flex h-auto w-full justify-start gap-3 p-3 text-left"
                  onClick={() => {
                    monacoRef.current?.insertSnippet(item.snippet);
                    setMediaDialogOpen(false);
                  }}
                >
                  <span className="truncate">{item.name}</span>
                  <span className="ml-auto text-xs text-text-secondary">
                    {item.kind === 'image' ? 'Картинка' : 'Видео'}
                  </span>
                </Button>
              ))
            ) : (
              <p className="text-sm text-text-secondary">Файлов пока нет</p>
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
