/**
 * Extension bridge for speakasm TTS (all voices, stoppable playback).
 */

import { createKokoroEngine } from '/js/engine/kokoro.js';

const statusEl = document.getElementById('status');
const params = new URLSearchParams(location.search);
const extId = params.get('extId') || '';

/** @type {Awaited<ReturnType<typeof createKokoroEngine>> | null} */
let engine = null;
/** @type {AbortController | null} */
let active = null;
/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {AudioBufferSourceNode | null} */
let playing = null;
/** @type {object[] | null} */
let voiceList = null;

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function extensionRuntime() {
  const root = globalThis.chrome || globalThis.browser;
  return root?.runtime;
}

async function loadVoices() {
  if (voiceList) return voiceList;
  try {
    const res = await fetch('/api/voices', { credentials: 'omit' });
    if (res.ok) {
      const data = await res.json();
      voiceList = data.voices || data || [];
      return voiceList;
    }
  } catch {
    /* fall through */
  }
  const res = await fetch('/voices.json', { credentials: 'omit' });
  const data = await res.json();
  voiceList = data.voices || [];
  return voiceList;
}

async function ensureEngine() {
  if (engine) return;
  setStatus('Loading Kokoro voice model…');
  engine = await createKokoroEngine();
  await engine.load();
  setStatus('Voice model ready');
}

function stopPlayback() {
  try {
    playing?.stop?.();
  } catch {
    /* ignore */
  }
  playing = null;
  active?.abort();
  active = null;
}

async function speak(text, opts) {
  await ensureEngine();
  stopPlayback();
  active = new AbortController();
  setStatus('Speaking…');
  const result = await engine.generate(text, {
    voice: opts.voice || 'af_heart',
    speed: opts.speed || 1,
    signal: active.signal,
  });
  const sampleRate = result.sampleRate || 24000;
  if (!audioCtx || audioCtx.sampleRate !== sampleRate) {
    await audioCtx?.close?.().catch(() => {});
    audioCtx = new AudioContext({ sampleRate });
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const buffer = audioCtx.createBuffer(1, result.audio.length, sampleRate);
  buffer.copyToChannel(result.audio, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(audioCtx.destination);
  playing = src;
  await new Promise((resolve, reject) => {
    src.onended = () => {
      playing = null;
      resolve();
    };
    try {
      src.start();
    } catch (err) {
      reject(err);
    }
  });
  setStatus('Ready');
  return { ok: true, samples: result.audio.length, sampleRate };
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('invalid message');
  switch (msg.type) {
    case 'ping':
      return {
        ok: true,
        name: 'speakasm',
        isolated: Boolean(globalThis.crossOriginIsolated),
        ready: Boolean(engine),
        playing: Boolean(playing),
      };
    case 'list-voices':
      return { voices: await loadVoices() };
    case 'speak': {
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!text.trim()) throw new Error('empty text');
      if (text.length > 20_000) throw new Error('text too large');
      return speak(text, { voice: msg.voice, speed: msg.speed });
    }
    case 'stop':
      stopPlayback();
      setStatus('Stopped');
      return { ok: true };
    case 'dispose':
      stopPlayback();
      engine?.dispose?.();
      engine = null;
      await audioCtx?.close?.().catch(() => {});
      audioCtx = null;
      return { ok: true };
    default:
      throw new Error('unknown type: ' + msg.type);
  }
}

function connect() {
  const runtime = extensionRuntime();
  if (!runtime || !extId) {
    setStatus('Open this page from the speakasm extension.');
    return;
  }
  let port;
  try {
    port = runtime.connect(extId, { name: 'speakasm-bridge' });
  } catch (err) {
    setStatus('Connect failed: ' + err);
    return;
  }
  setStatus('Connected. Keep this tab open while speaking.');
  port.onMessage.addListener((msg) => {
    const id = msg?.id;
    handleMessage(msg)
      .then((result) => port.postMessage({ id, ok: true, result }))
      .catch((err) => port.postMessage({ id, ok: false, error: String(err?.message || err) }));
  });
  port.onDisconnect.addListener(() => {
    setStatus('Extension disconnected.');
  });
  port.postMessage({ type: 'bridge-hello', name: 'speakasm' });
}

connect();
