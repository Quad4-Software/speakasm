/**
 * Main-thread Kokoro engine facade. Inference runs in a dedicated worker.
 */

export { splitForSpeech } from './kokoro-runtime.js';

/**
 * @typedef {{ device: 'webgpu' | 'wasm', dtype: 'fp32' | 'q8' }} BackendConfig
 */

/**
 * @returns {Promise<{
 *   load: () => Promise<void>,
 *   listVoices: () => string[],
 *   backend: () => BackendConfig | null,
 *   generate: (text: string, opts: {
 *     voice: string,
 *     speed?: number,
 *     signal?: AbortSignal,
 *     pieces?: string[],
 *     onPlan?: (info: { total: number }) => void,
 *     onChunk?: (info: { text: string, index: number, audio: Float32Array, sampleRate: number }) => void,
 *   }) => Promise<{ audio: Float32Array, sampleRate: number, chunks: number }>,
 *   dispose: () => void,
 * }>}
 */
export async function createKokoroEngine() {
  const worker = new Worker('/js/engine/kokoro-worker.js', { type: 'module' });
  let reqId = 0;
  /** @type {BackendConfig | null} */
  let active = null;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, onPlan?: Function, onChunk?: Function }>} */
  const pending = new Map();

  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    const slot = pending.get(msg.id);
    if (!slot) {
      return;
    }
    if (msg.type === 'plan') {
      slot.onPlan?.({ total: msg.total | 0 });
      return;
    }
    if (msg.type === 'chunk') {
      const audio =
        msg.audio instanceof Float32Array ? msg.audio : new Float32Array(msg.audio || []);
      slot.onChunk?.({
        text: msg.text || '',
        index: msg.index | 0,
        audio,
        sampleRate: msg.sampleRate || 24000,
      });
      return;
    }
    if (msg.type === 'ready') {
      active = msg.backend || null;
      pending.delete(msg.id);
      slot.resolve(undefined);
      return;
    }
    if (msg.type === 'done') {
      pending.delete(msg.id);
      const audio =
        msg.audio instanceof Float32Array ? msg.audio : new Float32Array(msg.audio || []);
      slot.resolve({
        audio,
        sampleRate: msg.sampleRate || 24000,
        chunks: msg.chunks | 0,
      });
      return;
    }
    if (msg.type === 'disposed') {
      pending.delete(msg.id);
      slot.resolve(undefined);
      return;
    }
    if (msg.type === 'error') {
      pending.delete(msg.id);
      const err =
        msg.name === 'AbortError'
          ? new DOMException(msg.error || 'Aborted', 'AbortError')
          : new Error(msg.error || 'Worker failed');
      slot.reject(err);
    }
  };

  worker.onerror = (ev) => {
    const err = new Error(ev.message || 'Kokoro worker crashed');
    for (const [id, slot] of pending) {
      pending.delete(id);
      slot.reject(err);
    }
  };

  /**
   * @param {string} type
   * @param {Record<string, any>} [payload]
   * @param {{ onPlan?: Function, onChunk?: Function, signal?: AbortSignal }} [hooks]
   */
  function call(type, payload = {}, hooks = {}) {
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      const signal = hooks.signal;
      const onAbort = () => {
        worker.postMessage({ id, type: 'cancel' });
        pending.delete(id);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
        onPlan: hooks.onPlan,
        onChunk: hooks.onChunk,
      });
      worker.postMessage({ id, type, ...payload });
    });
  }

  return {
    async load() {
      await call('load');
    },

    listVoices() {
      return [];
    },

    backend() {
      return active;
    },

    async generate(text, opts) {
      return call(
        'generate',
        {
          text,
          voice: opts.voice,
          speed: opts.speed,
        },
        {
          signal: opts.signal,
          onPlan: opts.onPlan,
          onChunk: opts.onChunk,
        },
      );
    },

    dispose() {
      void call('dispose').finally(() => {
        worker.terminate();
        active = null;
      });
    },
  };
}
