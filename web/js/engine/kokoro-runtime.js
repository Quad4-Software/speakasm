/**
 * Kokoro ONNX runtime (runs in a worker or on the main thread).
 */

const MODEL_ID = 'Kokoro-82M-v1.0-ONNX';
const CHUNK_MERGE_MAX = 450;
const WASM_THREAD_CAP = 4;
const KOKORO_RATE = 24000;
const WEBGPU_PROBE_TEXT =
  'Every single morning the baker kneaded the soft dough by hand before the shop opened.';
const WASM_FALLBACK = /** @type {BackendConfig} */ ({ device: 'wasm', dtype: 'q8' });

/** Session flag: WebGPU produced non-speech audio on this page load. */
let webgpuAudioBad = false;

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

  /**
   * @param {BackendConfig} cfg
   */
  async function loadModel(cfg) {
    tts = await KokoroTTS.from_pretrained(MODEL_ID, cfg);
    active = cfg;
  }

  /**
   * WebGPU EP can emit unintelligible HF noise on some GPUs/drivers.
   * Probe once and pin wasm if the output is not speech-like.
   */
  async function ensureWebGpuAudioQuality() {
    if (!tts || active?.device !== 'webgpu') {
      return;
    }
    if (webgpuAudioBad) {
      await loadModel(WASM_FALLBACK);
      return;
    }
    try {
      const probe = await tts.generate(WEBGPU_PROBE_TEXT, { voice: 'af_heart' });
      const { pcm } = unpackAudio(probe);
      if (isSpeechLikePcm(pcm)) {
        return;
      }
    } catch {
      /* treat probe failure as bad webgpu audio */
    }
    webgpuAudioBad = true;
    console.warn('speakasm: WebGPU audio failed quality probe; falling back to wasm/q8');
    await loadModel(WASM_FALLBACK);
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
        await loadModel(preferred);
        await ensureWebGpuAudioQuality();
      } catch (err) {
        if (preferred.device !== 'wasm') {
          await loadModel(WASM_FALLBACK);
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
      let sampleRate = KOKORO_RATE;
      let index = 0;

      const reader = (async () => {
        for await (const item of stream) {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          const { pcm, rate } = unpackAudio(item.audio);
          sampleRate = rate || sampleRate;
          parts.push(pcm);
          onChunk?.({
            text: item.text || '',
            index,
            audio: pcm,
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
  if (webgpuAudioBad) {
    return WASM_FALLBACK;
  }
  try {
    if (!navigator.gpu) {
      return WASM_FALLBACK;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) {
      return { device: 'webgpu', dtype: 'fp32' };
    }
  } catch {
    /* fall through to wasm */
  }
  return WASM_FALLBACK;
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
 * Copy PCM out of Kokoro/ORT buffers immediately (WebGPU may reuse tensors).
 * @param {any} audio
 * @returns {{ pcm: Float32Array, rate: number }}
 */
function unpackAudio(audio) {
  let pcm = new Float32Array(0);
  let rate = KOKORO_RATE;

  if (!audio) {
    return { pcm, rate };
  }

  if (typeof audio.sampling_rate === 'number' && audio.sampling_rate > 0) {
    rate = audio.sampling_rate;
  }

  if (audio instanceof Float32Array) {
    pcm = audio.slice();
  } else if (audio.audio instanceof Float32Array) {
    pcm = audio.audio.slice();
  } else if (ArrayBuffer.isView(audio.audio)) {
    pcm = Float32Array.from(audio.audio);
  } else if (ArrayBuffer.isView(audio)) {
    pcm = Float32Array.from(/** @type {ArrayLike<number>} */ (audio));
  } else if (audio.audio && typeof audio.audio === 'object' && ArrayBuffer.isView(audio.audio.data)) {
    pcm = Float32Array.from(audio.audio.data);
  }

  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    if (!Number.isFinite(v)) {
      pcm[i] = 0;
      continue;
    }
    const a = Math.abs(v);
    if (a > peak) {
      peak = a;
    }
  }
  // Some EP paths return int-ish magnitudes; normalize into Web Audio range.
  if (peak > 1.5) {
    const scale = 0.99 / peak;
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] *= scale;
    }
  }

  return { pcm, rate };
}

/**
 * Reject unintelligible HF / empty / non-finite WebGPU renders.
 * @param {Float32Array} pcm
 * @returns {boolean}
 */
function isSpeechLikePcm(pcm) {
  if (!pcm || pcm.length < 800) {
    return false;
  }
  const stride = Math.max(1, (pcm.length / 4000) | 0);
  let peak = 0;
  let sumSq = 0;
  let diffSq = 0;
  let zc = 0;
  let prev = 0;
  let n = 0;
  for (let i = 0; i < pcm.length; i += stride) {
    const v = pcm[i];
    if (!Number.isFinite(v)) {
      return false;
    }
    const a = Math.abs(v);
    if (a > peak) {
      peak = a;
    }
    sumSq += v * v;
    if (n > 0) {
      const d = v - prev;
      diffSq += d * d;
      if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) {
        zc += 1;
      }
    }
    prev = v;
    n += 1;
  }
  if (peak < 0.02 || peak > 4) {
    return false;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  if (rms < 0.005) {
    return false;
  }
  const hf = Math.sqrt(diffSq / Math.max(1, n));
  const zcRate = zc / Math.max(1, n);
  // Alien/HF garbage: derivative energy and zero-crossings far above speech.
  if (hf > rms * 4.5 && zcRate > 0.35) {
    return false;
  }
  if (zcRate > 0.48) {
    return false;
  }
  return true;
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
