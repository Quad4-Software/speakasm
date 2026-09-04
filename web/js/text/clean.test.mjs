import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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

  it('decodes entities without DOM', () => {
    assert.equal(cleanText('A &amp; B &#39;C&#39;'), "A & B 'C'");
  });
});
