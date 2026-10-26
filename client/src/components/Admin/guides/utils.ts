export function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function resolveMedia(html: string, media: Record<string, { url: string }> = {}): string {
  return html.replace(
    /\b(src|poster)=(["'])media\/([a-f0-9]{24})\2/gi,
    (match, attribute, quote, id) => {
      const item = media[id.toLowerCase()];
      return item ? `${attribute}=${quote}${escapeAttr(item.url)}${quote}` : match;
    },
  );
}

export function buildSrcDoc(html: string, mediaOrigin?: string): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data:${mediaOrigin ? ` ${mediaOrigin}` : ''}`,
    `media-src${mediaOrigin ? ` ${mediaOrigin}` : " 'none'"}`,
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => match + meta);
  }
  if (/<html(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(\s[^>]*)?>/i, (match) => `${match}<head>${meta}</head>`);
  }
  return `<!DOCTYPE html><html><head>${meta}</head><body>${html}</body></html>`;
}

export const IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

export function getErrorMessage(error: unknown): string {
  const response = (error as { response?: { data?: { message?: string } } })?.response;
  return response?.data?.message ?? 'Что-то пошло не так';
}
