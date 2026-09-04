import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// DOMParser/textarea stubs for clean.js in Node.
class FakeElement {
  constructor() {
    this._html = '';
  }
  set innerHTML(v) {
    this._html = String(v)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  get value() {
    return this._html;
  }
}

globalThis.document = {
  createElement() {
    return new FakeElement();
  },
};

const { cleanText } = await import('./clean.js');

describe('cleanText', () => {
  it('strips markdown and collapses junk', () => {
    const out = cleanText('# Title\n\nHello **world** [link](https://x.test)\n\n---\nPage 3\n');
    assert.match(out, /Title/);
    assert.match(out, /Hello world link/);
    assert.doesNotMatch(out, /Page 3/);
    assert.doesNotMatch(out, /\*\*/);
  });

  it('returns empty for blank input', () => {
    assert.equal(cleanText('   '), '');
  });
});
