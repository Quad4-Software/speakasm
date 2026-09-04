/**
 * Load text from plain files, Markdown, HTML, EPUB, and DOCX.
 */

import { cleanText, htmlToText } from '../text/clean.js';

const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'text', 'csv', 'log', 'rtf']);
const HTML_EXTS = new Set(['html', 'htm', 'xhtml']);

/**
 * @param {File} file
 * @returns {Promise<{ text: string, source: string }>}
 */
export async function extractFromFile(file) {
  const name = file.name || 'document';
  const ext = extensionOf(name);
  const lowerType = (file.type || '').toLowerCase();

  if (ext === 'epub' || lowerType.includes('epub')) {
    return { text: await extractEpub(file), source: name };
  }
  if (ext === 'docx' || lowerType.includes('wordprocessingml')) {
    return { text: await extractDocx(file), source: name };
  }
  if (ext === 'pdf' || lowerType === 'application/pdf') {
    throw new Error('PDF support needs a local pdf.js build. Convert to TXT or EPUB for now.');
  }
  if (HTML_EXTS.has(ext) || lowerType.includes('html')) {
    const raw = await file.text();
    return { text: htmlToText(raw), source: name };
  }
  if (TEXT_EXTS.has(ext) || lowerType.startsWith('text/') || ext === '') {
    const raw = await file.text();
    return { text: cleanText(raw), source: name };
  }

  // Last resort: try as text.
  const raw = await file.text();
  return { text: cleanText(raw), source: name };
}

/**
 * @param {string} name
 * @returns {string}
 */
function extensionOf(name) {
  const i = name.lastIndexOf('.');
  if (i < 0) {
    return '';
  }
  return name.slice(i + 1).toLowerCase();
}

/**
 * @param {File} file
 * @returns {Promise<string>}
 */
async function extractEpub(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = await zip.file('META-INF/container.xml')?.async('string');
  if (!container) {
    throw new Error('Invalid EPUB: missing container.xml');
  }
  const rootMatch = container.match(/full-path=["']([^"']+)["']/i);
  if (!rootMatch) {
    throw new Error('Invalid EPUB: missing rootfile');
  }
  const opfPath = rootMatch[1];
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = await zip.file(opfPath)?.async('string');
  if (!opf) {
    throw new Error('Invalid EPUB: missing package document');
  }

  const manifest = new Map();
  const itemRe = /<item\b[^>]*>/gi;
  let m;
  while ((m = itemRe.exec(opf))) {
    const tag = m[0];
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    const media = (attr(tag, 'media-type') || '').toLowerCase();
    if (id && href) {
      manifest.set(id, { href, media });
    }
  }

  const spine = [];
  const itemrefRe = /<itemref\b[^>]*>/gi;
  while ((m = itemrefRe.exec(opf))) {
    const idref = attr(m[0], 'idref');
    if (!idref) {
      continue;
    }
    const item = manifest.get(idref);
    if (!item) {
      continue;
    }
    if (item.media.includes('html') || item.href.match(/\.x?html?$/i)) {
      spine.push(joinPath(opfDir, item.href));
    }
  }

  if (!spine.length) {
    throw new Error('EPUB has no readable chapters.');
  }

  const parts = [];
  for (const path of spine) {
    const html = await zip.file(path)?.async('string');
    if (!html) {
      continue;
    }
    const chapter = htmlToText(html);
    if (chapter) {
      parts.push(chapter);
    }
  }
  return cleanText(parts.join('\n\n'));
}

/**
 * @param {File} file
 * @returns {Promise<string>}
 */
async function extractDocx(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) {
    throw new Error('Invalid DOCX: missing document.xml');
  }
  const withBreaks = xml
    .replace(/<w:tab\b[^/]*\/>/g, '\t')
    .replace(/<w:br\b[^/]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n');
  // OOXML to plain text via XML DOM. Not HTML sanitization.
  const doc = new DOMParser().parseFromString(withBreaks, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Invalid DOCX: document.xml parse failed');
  }
  return cleanText(doc.documentElement?.textContent || '');
}

/**
 * @returns {Promise<any>}
 */
async function loadJSZip() {
  if (globalThis.JSZip) {
    return globalThis.JSZip;
  }
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jszip/jszip.min.js';
    s.async = true;
    s.onload = () => resolve(undefined);
    s.onerror = () => reject(new Error('JSZip failed to load. Run make assets.'));
    document.head.appendChild(s);
  });
  if (!globalThis.JSZip) {
    throw new Error('JSZip failed to load. Run make assets.');
  }
  return globalThis.JSZip;
}

/**
 * @param {string} tag
 * @param {string} name
 * @returns {string}
 */
function attr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = tag.match(re);
  return m ? m[1] : '';
}

/**
 * @param {string} base
 * @param {string} rel
 * @returns {string}
 */
function joinPath(base, rel) {
  if (!rel) {
    return base;
  }
  if (rel.startsWith('/')) {
    return rel.slice(1);
  }
  const stack = base.split('/').filter(Boolean);
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}
