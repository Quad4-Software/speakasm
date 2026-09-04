/**
 * Strip markup, ebook junk, and layout noise into clean spoken text.
 */

/**
 * @param {string} input
 * @returns {string}
 */
export function cleanText(input) {
  if (!input) {
    return '';
  }
  let text = String(input);

  text = text.replace(/\uFEFF/g, '');
  text = text.replace(/\r\n?/g, '\n');

  // Drop common ebook/nav boilerplate blocks.
  text = text.replace(/(?:^|\n)\s*(?:table of contents|contents|copyright|all rights reserved|isbn[:\s].*|www\.[^\s]+)\s*(?:\n|$)/gim, '\n');

  // Markdown images and links.
  text = text.replace(/!\[[^\]]*]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)]\([^)]*\)/g, '$1');
  text = text.replace(/`{1,3}[^`]*`{1,3}/g, ' ');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  text = text.replace(/[*_~]{1,3}/g, '');

  // HTML leftovers. Prefer the DOM when available so script/style bodies are
  // dropped without fragile tag regexes.
  if (typeof DOMParser !== 'undefined' && /<[a-z!?/]/i.test(text)) {
    text = htmlFragmentToText(text);
  } else {
    text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
    text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
    text = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  }
  text = decodeEntities(text);

  // Page markers and decorative lines.
  text = text.replace(/^\s*(?:page\s+\d+(?:\s+of\s+\d+)?|\d+)\s*$/gim, '');
  text = text.replace(/^[-=_*~.]{3,}\s*$/gm, '');
  text = text.replace(/_{2,}/g, ' ');

  // Collapse whitespace while keeping paragraph breaks.
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\u00a0/g, ' ');

  return text.trim();
}

/**
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (!html) {
    return '';
  }
  return cleanText(htmlFragmentToText(String(html)));
}

/**
 * Extract visible text from an HTML fragment via the DOM.
 * Output is plain text for TTS, never reinserted as HTML.
 * @param {string} html
 * @returns {string}
 */
function htmlFragmentToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg, img').forEach((el) => el.remove());
  const body = doc.body || doc.documentElement;
  return body ? body.textContent || '' : '';
}

/**
 * Decode common HTML entities without touching the DOM.
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, '\u00a0')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    })
    .replace(/&amp;/gi, '&');
}
