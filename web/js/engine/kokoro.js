/**
 * Local Kokoro-82M ONNX engine via vendored kokoro-js.
 */

const MODEL_ID = 'Kokoro-82M-v1.0-ONNX';
const DEFAULT_DTYPE = 'q8';

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   locale: string,
 *   gender: string,
 *   grade?: string,
 *   default?: boolean,
 *   size_hint_mb: number,
 *   notes?: string,
 * }} VoiceInfo
 */

/**
 * @returns {Promise<{
 *   load: () => Promise<void>,
 *   listVoices: () => string[],
 *   generate: (text: string, opts: {
 *     voice: string,
 *     speed?: number,
 *     signal?: AbortSignal,
 *     onChunk?: (info: { text: string, index: number, audio: Float32Array, sampleRate: number }) => void,
 *   }) => Promise<{ audio: Float32Array, sampleRate: number, chunks: number }>,
 *   dispose: () => void,
 * }>}
 */
export async function createKokoroEngine() {
  const { env, KokoroTTS, TextSplitterStream } = await import('/vendor/kokoro/kokoro.js');

  // Fully local: no Hugging Face fetches at runtime.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = '/models/';
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = '/vendor/kokoro/';
  }

  /** @type {any} */
  let tts = null;
  let loading = /** @type {Promise<void> | null} */ (null);

  async function load() {
    if (tts) {
      return;
    }
    if (loading) {
      await loading;
      return;
    }
    loading = (async () => {
      // Ship q8 only (~92MB). Prefer WebGPU when available, else WASM.
      const preferred = await pickDevice();
      try {
        tts = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: DEFAULT_DTYPE,
          device: preferred,
        });
      } catch (err) {
        if (preferred !== 'wasm') {
          tts = await KokoroTTS.from_pretrained(MODEL_ID, {
            dtype: DEFAULT_DTYPE,
            device: 'wasm',
          });
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

      // Feed in sentence-sized chunks for lower latency.
      const pieces = splitForSpeech(text);
      for (const piece of pieces) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        splitter.push(piece);
      }
      splitter.close();
      await reader;

      const audio = concat(parts);
      return { audio, sampleRate, chunks: parts.length };
    },

    dispose() {
      tts = null;
    },
  };
}

/**
 * @returns {Promise<'webgpu' | 'wasm'>}
 */
async function pickDevice() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        return 'webgpu';
      }
    }
  } catch {
    /* fall through */
  }
  return 'wasm';
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
    if (next.length > 280 && buf) {
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
