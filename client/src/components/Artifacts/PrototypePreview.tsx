import { useEffect, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import { Expand, X } from 'lucide-react';
import { dataService, PROTOTYPE_LAYOUT_COMPAT_CSS } from 'librechat-data-provider';
import { useResetRecoilState, useSetRecoilState } from 'recoil';
import store from '~/store';

export default function PrototypePreview({
  jobId,
  conversationId,
  htmlDigest,
}: {
  jobId: string;
  conversationId: string;
  htmlDigest?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const resetPreview = useResetRecoilState(store.prototypePreview);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const resetArtifactId = useResetRecoilState(store.currentArtifactId);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => {
    let canceled = false;
    setError(null);
    void dataService
      .getPrototypeHtml(jobId, conversationId)
      .then(async (response) => {
        const html = await response.data.text();
        if (canceled) return;
        const documentNode = new DOMParser().parseFromString(html, 'text/html');
        const policy = documentNode.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        policy.content =
          "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'";
        documentNode.head.prepend(policy);
        const kitColors = documentNode.createElement('style');
        kitColors.textContent =
          [
            'primary',
            'secondary',
            'tertiary',
            'inverse',
            'translucent',
            'accent-blue',
            'translucent-blue',
            'accent-violet',
            'translucent-violet',
            'destructive',
          ]
            .map(
              (variant) =>
                `button[class~="bg-[var(--btn-${variant}-bg)]"]:not(:disabled) { color: var(--btn-${variant}-color); }`,
            )
            .join('\n') +
          '\n' +
          PROTOTYPE_LAYOUT_COMPAT_CSS;
        documentNode.head.append(kitColors);
        setPreviewHtml(`<!doctype html>${documentNode.documentElement.outerHTML}`);
        setError(null);
      })
      .catch(() => {
        if (!canceled) setError('The accepted preview could not be loaded.');
      });
    return () => {
      canceled = true;
    };
  }, [conversationId, jobId, htmlDigest, retry]);

  const close = () => {
    resetPreview();
    resetArtifactId();
    setArtifactsVisible(false);
  };

  const requestFullscreen = async () => {
    try {
      if (document.fullscreenElement === container.current) {
        await document.exitFullscreen();
      } else {
        await container.current?.requestFullscreen();
      }
      setError(null);
    } catch {
      setError('The browser declined fullscreen mode.');
    }
  };

  return (
    <div
      ref={container}
      className="flex h-full min-h-0 w-full flex-col bg-surface-primary text-text-primary"
    >
      <div className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border-light bg-surface-secondary px-3 text-text-primary">
        <div>
          <span className="font-medium">Предпросмотр прототипа</span>
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
        </div>
        <div className="flex gap-1">
          {error && (
            <Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>
              Retry preview
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="text-text-primary hover:bg-surface-hover"
            onClick={requestFullscreen}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={fullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}
          >
            <Expand className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="text-text-primary hover:bg-surface-hover"
            onClick={close}
            aria-label="Close preview"
            title="Закрыть предпросмотр"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <iframe
        title="Accepted prototype"
        srcDoc={previewHtml ?? '<!doctype html><title>Loading accepted prototype</title>'}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}
