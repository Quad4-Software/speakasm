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

  // HTML leftovers.
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
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
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  doc.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg, img').forEach((el) => el.remove());
  const body = doc.body || doc.documentElement;
  const text = body ? body.textContent || '' : '';
  return cleanText(text);
}

/**
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}
