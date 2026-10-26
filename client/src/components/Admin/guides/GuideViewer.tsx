import { useEffect, useLayoutEffect, useState } from 'react';
import { useSetRecoilState } from 'recoil';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@librechat/client';
import GuideFrame from './GuideFrame';
import type { GuideMediaMap } from './api';
import { fetchGuide, fetchPublishedGuide } from './api';
import store from '~/store';

type Status = 'loading' | 'ready' | 'empty' | 'error';

export default function GuideViewer({ mode }: { mode: 'published' | 'draft' }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const setSidebarExpanded = useSetRecoilState(store.sidebarExpanded);
  const [document, setDocument] = useState<{
    title: string;
    html: string;
    media?: GuideMediaMap;
    mediaOrigin?: string;
  } | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useLayoutEffect(() => {
    if (mode === 'published') setSidebarExpanded(false);
  }, [mode, setSidebarExpanded]);

  useEffect(() => {
    let cancelled = false;
    const load = async (withLoading = true) => {
      if (withLoading) setStatus('loading');
      try {
        const result =
          mode === 'published'
            ? await fetchPublishedGuide()
            : await fetchGuide(id as string).then((guide) => ({
                title: guide.guide.title,
                html: guide.html,
                media: guide.media,
                mediaOrigin: guide.mediaOrigin,
              }));
        if (cancelled) return;
        setDocument(result);
        setStatus('ready');
      } catch (error) {
        if (!cancelled) {
          setStatus(
            (error as { response?: { status?: number } })?.response?.status === 404
              ? 'empty'
              : 'error',
          );
        }
      }
    };
    void load();
    const refresh = window.setInterval(() => void load(false), 45 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(refresh);
    };
  }, [id, mode]);

  return (
    <div className="flex h-dvh w-full flex-col bg-white">
      {mode === 'draft' && (
        <header className="flex h-12 shrink-0 items-center border-b border-gray-200 bg-white px-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => navigate('/admin/guides')}
            className="gap-1"
          >
            <ArrowLeft size={16} /> К руководству
          </Button>
        </header>
      )}
      {status === 'ready' && document && (
        <GuideFrame
          html={document.html}
          title={document.title}
          media={document.media}
          mediaOrigin={document.mediaOrigin}
          className="min-h-0 w-full flex-1"
        />
      )}
      {status === 'loading' && <div className="p-6 text-gray-500">Загрузка…</div>}
      {status === 'empty' && (
        <div className="p-6 text-gray-500">Руководство пока не опубликовано.</div>
      )}
      {status === 'error' && <div className="p-6 text-red-500">Не удалось загрузить страницу.</div>}
    </div>
  );
}
