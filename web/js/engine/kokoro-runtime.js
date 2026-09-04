/**
 * Kokoro ONNX runtime (runs in a worker or on the main thread).
 */

const MODEL_ID = 'Kokoro-82M-v1.0-ONNX';
const CHUNK_MERGE_MAX = 450;
const WASM_THREAD_CAP = 4;

/**
 * @typedef {{ device: 'webgpu' | 'wasm', dtype: 'fp32' | 'q8' }} BackendConfig
 */

/**
 * @returns {Promise<{
 *   load: () => Promise<void>,
 *   listVoices: () => string[],
 *   backend: () => BackendConfig | null,
 *   planTotal: (pieces: string[]) => number,
 *   generate: (text: string, opts: {
 *     voice: string,
 *     speed?: number,
 *     signal?: AbortSignal,
 *     pieces?: string[],
 *     onChunk?: (info: { text: string, index: number, audio: Float32Array, sampleRate: number }) => void,
 *   }) => Promise<{ audio: Float32Array, sampleRate: number, chunks: number }>,
 *   dispose: () => void,
 * }>}
 */
export async function createKokoroRuntime() {
  const { env, KokoroTTS, TextSplitterStream } = await import('/vendor/kokoro/kokoro.js');

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = '/models/';
  env.useBrowserCache = false;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = '/vendor/kokoro/';
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1;
    env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(WASM_THREAD_CAP, cores));
  } else if ('wasmPaths' in env) {
    env.wasmPaths = '/vendor/kokoro/';
  }

  /** @type {any} */
  let tts = null;
  /** @type {BackendConfig | null} */
  let active = null;
  let loading = /** @type {Promise<void> | null} */ (null);

  /**
   * Count the sentence units TextSplitterStream will emit for these pieces.
   * Merged pieces are re-split by Kokoro, so pieces.length is not the chunk total.
   * @param {string[]} pieces
   * @returns {number}
   */
  function planTotal(pieces) {
    if (!pieces.length) {
      return 0;
    }
    const splitter = new TextSplitterStream();
    for (const piece of pieces) {
      splitter.push(piece);
    }
    splitter.close();
    let n = 0;
    for (const _ of splitter) {
      n += 1;
    }
    return n;
  }

  async function load() {
    if (tts) {
      return;
    }
    if (loading) {
      await loading;
      return;
    }
    loading = (async () => {
      const preferred = await pickBackend();
      try {
        tts = await KokoroTTS.from_pretrained(MODEL_ID, preferred);
        active = preferred;
      } catch (err) {
        if (preferred.device !== 'wasm') {
          const fallback = /** @type {BackendConfig} */ ({ device: 'wasm', dtype: 'q8' });
          tts = await KokoroTTS.from_pretrained(MODEL_ID, fallback);
          active = fallback;
        } else {
          throw err;
        }
      }
    })();
    try {
      await loading;
    } finally {
      loading = null;
    }
  }

  return {
    async load() {
      await load();
    },

    listVoices() {
      if (!tts) {
        return [];
      }
      try {
        return tts.list_voices();
      } catch {
        return [];
      }
    },

    backend() {
      return active;
    },

    /**
     * @param {string[]} pieces
     * @returns {number}
     */
    planTotal(pieces) {
      return planTotal(pieces);
    },

    async generate(text, opts) {
      await load();
      if (!tts) {
        throw new Error('Kokoro engine failed to load.');
      }
      const voice = opts.voice || 'af_heart';
      const speed = clamp(opts.speed ?? 1, 0.5, 2);
      const signal = opts.signal;
      const onChunk = opts.onChunk;

      const splitter = new TextSplitterStream();
      const stream = tts.stream(splitter, { voice, speed });
      const parts = /** @type {Float32Array[]} */ ([]);
      let sampleRate = 24000;
      let index = 0;

      const reader = (async () => {
        for await (const item of stream) {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          const audio = toFloat32(item.audio);
          sampleRate = item.audio?.sampling_rate || item.sampling_rate || sampleRate;
          parts.push(audio);
          onChunk?.({
            text: item.text || '',
            index,
            audio,
            sampleRate,
          });
          index += 1;
        }
      })();

      const pieces = opts.pieces || splitForSpeech(text);
      for (const piece of pieces) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        splitter.push(piece);
      }
      splitter.close();
      await reader;

      const chunks = parts.length;
      const audio = concat(parts);
      parts.length = 0;
      return { audio, sampleRate, chunks };
    },

    dispose() {
      tts = null;
      active = null;
    },
  };
}

/**
 * @returns {Promise<BackendConfig>}
 */
async function pickBackend() {
  try {
    if (!navigator.gpu) {
      return { device: 'wasm', dtype: 'q8' };
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) {
      return { device: 'webgpu', dtype: 'fp32' };
    }
  } catch {
    /* fall through to wasm */
  }
  return { device: 'wasm', dtype: 'q8' };
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function splitForSpeech(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }
  const parts = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
  const out = [];
  let buf = '';
  for (const part of parts) {
    const next = (buf + ' ' + part).trim();
    if (next.length > CHUNK_MERGE_MAX && buf) {
      out.push(buf);
      buf = part.trim();
    } else {
      buf = next;
    }
  }
  if (buf) {
    out.push(buf);
  }
  return out;
}

/**
 * @param {any} audio
 * @returns {Float32Array}
 */
function toFloat32(audio) {
  if (!audio) {
    return new Float32Array(0);
  }
  if (audio instanceof Float32Array) {
    return audio;
  }
  if (audio.audio instanceof Float32Array) {
    return audio.audio;
  }
  if (ArrayBuffer.isView(audio.audio)) {
    return Float32Array.from(audio.audio);
  }
  if (ArrayBuffer.isView(audio)) {
    return Float32Array.from(/** @type {ArrayLike<number>} */ (audio));
  }
  return new Float32Array(0);
}

/**
 * @param {Float32Array[]} parts
 * @returns {Float32Array}
 */
function concat(parts) {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
