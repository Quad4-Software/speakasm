/**
 * Web Worker that owns Kokoro ONNX load and generation.
 */

import { cleanText } from '../text/clean.js';
import { createKokoroRuntime, splitForSpeech } from './kokoro-runtime.js';

/** @type {Awaited<ReturnType<typeof createKokoroRuntime>> | null} */
let runtime = null;
/** @type {AbortController | null} */
let genAbort = null;

self.onmessage = (ev) => {
  const msg = ev.data || {};
  void handle(msg).catch((err) => {
    const id = msg.id;
    self.postMessage({
      id,
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
      name: err && typeof err === 'object' && 'name' in err ? String(err.name) : 'Error',
    });
  });
};

/**
 * @param {any} msg
 */
async function handle(msg) {
  const { id, type } = msg;
  if (type === 'cancel') {
    genAbort?.abort();
    genAbort = null;
    return;
  }

  if (type === 'load') {
    if (!runtime) {
      runtime = await createKokoroRuntime();
    }
    await runtime.load();
    self.postMessage({ id, type: 'ready', backend: runtime.backend() });
    return;
  }

  if (type === 'dispose') {
    genAbort?.abort();
    genAbort = null;
    runtime?.dispose();
    runtime = null;
    self.postMessage({ id, type: 'disposed' });
    return;
  }

  if (type === 'generate') {
    if (!runtime) {
      runtime = await createKokoroRuntime();
    }
    genAbort?.abort();
    genAbort = new AbortController();
    const signal = genAbort.signal;

    const cleaned = cleanText(String(msg.text || ''));
    const pieces = splitForSpeech(cleaned);
    const planned = runtime.planTotal(pieces);
    self.postMessage({ id, type: 'plan', total: Math.max(1, planned || pieces.length) });

    if (!cleaned) {
      self.postMessage({
        id,
        type: 'done',
        sampleRate: 24000,
        chunks: 0,
        audio: new Float32Array(0),
      });
      return;
    }

    const result = await runtime.generate(cleaned, {
      voice: msg.voice || 'af_heart',
      speed: msg.speed,
      pieces,
      signal,
      onChunk: ({ text, index, audio, sampleRate }) => {
        const copy = audio.slice();
        self.postMessage(
          {
            id,
            type: 'chunk',
            text,
            index,
            sampleRate,
            audio: copy,
          },
          [copy.buffer],
        );
      },
    });

    genAbort = null;
    const out = result.audio;
    self.postMessage(
      {
        id,
        type: 'done',
        sampleRate: result.sampleRate,
        chunks: result.chunks,
        audio: out,
      },
      out.byteLength ? [out.buffer] : [],
    );
    return;
  }

  throw new Error(`Unknown worker message: ${type}`);
}
