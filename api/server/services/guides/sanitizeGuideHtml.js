const sanitizeHtml = require('sanitize-html');

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const DATA_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const MEDIA_REF = /^media\/[a-f0-9]{24}$/;

function cleanCss(css = '') {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '(')
    .replace(/(-moz-binding|behavior)\s*:/gi, 'x:')
    .replace(/url\(\s*(['"]?)(?!\s*data:)[^)]*\)/gi, 'none');
}

const allowedTags = [
  'html',
  'head',
  'body',
  'title',
  'style',
  'header',
  'footer',
  'main',
  'nav',
  'section',
  'article',
  'aside',
  'div',
  'span',
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'a',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'mark',
  'code',
  'pre',
  'kbd',
  'samp',
  'blockquote',
  'q',
  'cite',
  'abbr',
  'details',
  'summary',
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'img',
  'figure',
  'figcaption',
  'video',
  'source',
];

const sanitizeOptions = {
  allowedTags,
  allowVulnerableTags: true,
  // sanitize-html removes the contents of these tags, even if a tag is allowed.
  // Keep style out of this list so in-document CSS survives publication.
  nonTextTags: ['script', 'textarea', 'option'],
  allowedAttributes: {
    '*': ['class', 'id', 'style', 'title', 'lang', 'dir', 'role', 'aria-*'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    video: [
      'src',
      'controls',
      'preload',
      'width',
      'height',
      'poster',
      'muted',
      'loop',
      'playsinline',
    ],
    source: ['src', 'type'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    col: ['span', 'width'],
    ol: ['start', 'type'],
    details: ['open'],
    html: ['lang'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  transformTags: {
    '*': (tagName, attribs) => {
      const next = { ...attribs };
      if (next.style) {
        next.style = cleanCss(next.style);
      }
      if (tagName === 'a' && /^https?:/i.test(next.href || '')) {
        next.target = '_blank';
        next.rel = 'noopener noreferrer';
      }
      if (tagName === 'img' && !DATA_IMG.test(next.src || '') && !MEDIA_REF.test(next.src || '')) {
        delete next.src;
      }
      if ((tagName === 'video' || tagName === 'source') && !MEDIA_REF.test(next.src || ''))
        delete next.src;
      if (
        tagName === 'video' &&
        next.poster &&
        !DATA_IMG.test(next.poster) &&
        !MEDIA_REF.test(next.poster)
      )
        delete next.poster;
      return { tagName, attribs: next };
    },
  },
  textFilter: (text, tagName) => (tagName === 'style' ? cleanCss(text) : text),
};

function extractTitle(raw, fallback = 'Без названия') {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = (match ? match[1] : '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, 200);
  return title || fallback;
}

function validateRawHtml(html) {
  if (typeof html !== 'string') {
    return 'Поле html должно быть строкой';
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return 'Файл больше 2 МБ';
  }
  if (html.includes('\0')) {
    return 'Недопустимые символы в файле';
  }
  if (!/<[a-z!][^>]*>/i.test(html)) {
    return 'Файл не похож на HTML';
  }
  return null;
}

function sanitizeGuideHtml(raw) {
  // sanitize-html preserves style content when `style` is removed from
  // nonTextTags, but does not pass its text through textFilter. Clean it
  // before parsing so @import and external url() values cannot survive.
  const cssCleaned = raw.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi,
    (_match, attributes, css) => `<style${attributes}>${cleanCss(css)}</style>`,
  );
  const clean = sanitizeHtml(cssCleaned, sanitizeOptions);
  const document = /<html[\s>]/i.test(clean)
    ? clean
    : `<html><head></head><body>${clean}</body></html>`;
  return `<!DOCTYPE html>\n${document}`;
}

module.exports = { MAX_HTML_BYTES, extractTitle, validateRawHtml, sanitizeGuideHtml };
