import { useMemo } from 'react';
import type { GuideMediaMap } from './api';
import { buildSrcDoc, IFRAME_SANDBOX, resolveMedia } from './utils';

export default function GuideFrame({
  html,
  title,
  className = '',
  preview = false,
  media,
  mediaOrigin,
}: {
  html: string;
  title: string;
  className?: string;
  preview?: boolean;
  media?: GuideMediaMap;
  mediaOrigin?: string;
}) {
  const srcDoc = useMemo(
    () => buildSrcDoc(resolveMedia(html, media), mediaOrigin),
    [html, media, mediaOrigin],
  );
  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox={IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      tabIndex={preview ? -1 : undefined}
      aria-hidden={preview || undefined}
      scrolling={preview ? 'no' : undefined}
      className={`border-0 bg-white ${className}`}
    />
  );
}
