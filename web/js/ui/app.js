import { createKokoroEngine, splitForSpeech } from '../engine/kokoro.js';
import { extractFromFile } from '../docs/extract.js';
import { cleanText } from '../text/clean.js';
import { concatAudio, encodeWav } from '../audio/wav.js';
import { createWaveController } from './wave.js';
import { cacheModelUrls, setupInstallAffordance } from '../pwa.js';

/**
 * Wire the page UI.
 */
export async function bootApp() {
  const els = {
    voice: /** @type {HTMLSelectElement} */ (document.getElementById('voice')),
    speed: /** @type {HTMLInputElement} */ (document.getElementById('speed')),
    speedVal: /** @type {HTMLElement} */ (document.getElementById('speed-val')),
    input: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')),
    btnSpeak: /** @type {HTMLButtonElement} */ (document.getElementById('btn-speak')),
    btnStop: /** @type {HTMLButtonElement} */ (document.getElementById('btn-stop')),
    btnPlay: /** @type {HTMLButtonElement} */ (document.getElementById('btn-play')),
    btnDownload: /** @type {HTMLButtonElement} */ (document.getElementById('btn-download')),
    btnClear: /** @type {HTMLButtonElement} */ (document.getElementById('btn-clear')),
    btnOffline: /** @type {HTMLButtonElement} */ (document.getElementById('btn-offline')),
    btnInstall: /** @type {HTMLButtonElement} */ (document.getElementById('btn-install')),
    btnIosTip: /** @type {HTMLButtonElement} */ (document.getElementById('btn-ios-tip')),
    iosTipPanel: /** @type {HTMLElement} */ (document.getElementById('ios-tip-panel')),
    file: /** @type {HTMLInputElement} */ (document.getElementById('file')),
    status: /** @type {HTMLElement} */ (document.getElementById('status')),
    spinner: /** @type {HTMLElement} */ (document.getElementById('spinner')),
    livePill: /** @type {HTMLElement} */ (document.getElementById('live-pill')),
    progress: /** @type {HTMLElement} */ (document.getElementById('progress')),
    progressTrack: /** @type {HTMLElement} */ (document.querySelector('.progress-track')),
    error: /** @type {HTMLElement} */ (document.getElementById('error')),
    meta: /** @type {HTMLElement} */ (document.getElementById('meta')),
    wave: /** @type {HTMLCanvasElement} */ (document.getElementById('wave')),
    dropOverlay: /** @type {HTMLElement} */ (document.getElementById('drop-overlay')),
    charCount: /** @type {HTMLElement} */ (document.getElementById('char-count')),
    scrub: /** @type {HTMLInputElement} */ (document.getElementById('scrub')),
    timeCur: /** @type {HTMLElement} */ (document.getElementById('time-cur')),
    timeTotal: /** @type {HTMLElement} */ (document.getElementById('time-total')),
    playback: /** @type {HTMLElement} */ (document.getElementById('playback')),
  };

  const wave = createWaveController(els.wave);
  wave.start();
  setupInstallAffordance({
    installBtn: els.btnInstall,
    iosTipBtn: els.btnIosTip,
    iosTipPanel: els.iosTipPanel,
  });

  /** @type {{ id: string, label: string, locale: string, gender: string, default?: boolean, notes?: string }[]} */
  let voices = [];
  const engine = await createKokoroEngine();
  let busy = false;
  /** @type {AbortController | null} */
  let abort = null;
  /** @type {Float32Array | null} */
  let lastAudio = null;
  let lastRate = 24000;
  /** @type {AudioContext | null} */
  let playCtx = null;
  /** @type {AudioBufferSourceNode | null} */
  let playSource = null;
  /** @type {AnalyserNode | null} */
  let analyser = null;
  let analyseWatch = 0;
  let dragDepth = 0;
  /** @type {Array<{ pcm: Float32Array, rate: number }>} */
  let playQueue = [];
  let playPump = false;
  let streaming = false;
  let replayPlaying = false;
  let replayPaused = false;
  let replayOffset = 0;
  let replayStartedAt = 0;
  let scrubbing = false;
  let clockWatch = 0;

  setBusy(true, 'Getting ready...');
  try {
    voices = await loadVoices();
    fillVoices(els.voice, voices);
    clearError();
    setStatus('Warming up Kokoro...');
    wave.setMode('loading');
    await engine.load();
    setBusy(false, 'Ready when you are.');
    els.status.classList.add('is-ok');
    wave.setMode('idle');
    syncActions();
  } catch (err) {
    setBusy(false, 'Could not finish setup.');
    showError(friendlyError(err));
    wave.setMode('idle');
  }

  els.input.addEventListener('input', () => {
    updateCharCount();
    syncActions();
  });
  els.speed.addEventListener('input', () => {
    els.speedVal.textContent = `${Number(els.speed.value).toFixed(2)}x`;
  });
  els.btnSpeak.addEventListener('click', () => void speak());
  els.btnStop.addEventListener('click', () => stopAll());
  els.btnPlay.addEventListener('click', () => void toggleReplay());
  els.btnDownload.addEventListener('click', () => downloadWav());
  els.btnClear.addEventListener('click', () => clearAll());
  els.file.addEventListener('change', () => void onFile());
  els.btnOffline.addEventListener('click', () => void saveOffline());

  els.scrub.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  els.scrub.addEventListener('pointerup', () => {
    scrubbing = false;
    seekReplay(Number(els.scrub.value) / 1000);
  });
  els.scrub.addEventListener('change', () => {
    scrubbing = false;
    seekReplay(Number(els.scrub.value) / 1000);
  });
  els.scrub.addEventListener('input', () => {
    if (!lastAudio) {
      return;
    }
    const ratio = Number(els.scrub.value) / 1000;
    const dur = lastAudio.length / lastRate;
    els.timeCur.textContent = formatDuration(ratio * dur);
  });

  wireDrop();
  updateCharCount();
  syncPlaybackUi();

  /**
   * @returns {Promise<typeof voices>}
   */
  async function loadVoices() {
    const sources = ['/voices.json', '/api/voices'];
    for (const url of sources) {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) {
          continue;
        }
        const data = await res.json();
        if (Array.isArray(data.voices) && data.voices.length) {
          return data.voices;
        }
      } catch {
        /* try next */
      }
    }
    throw new Error('Could not load voices.');
  }

  /**
   * @param {HTMLSelectElement} select
   * @param {typeof voices} list
   */
  function fillVoices(select, list) {
    select.replaceChildren();
    for (const v of list) {
      const opt = document.createElement('option');
      opt.value = v.id;
      const locale = v.locale === 'en-gb' ? 'UK' : 'US';
      opt.textContent = `${v.label} (${locale}, ${v.gender})`;
      if (v.default) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }
  }

  async function speak() {
    const raw = els.input.value;
    const text = cleanText(raw);
    if (!text) {
      showError('Paste some text or open a document first.');
      return;
    }
    if (busy) {
      return;
    }

    stopPlayback(true);
    abort = new AbortController();
    streaming = true;
    setBusy(true, 'Speaking...');
    wave.setMode('speaking');
    els.livePill.classList.add('is-on');
    els.playback.classList.add('is-active');
    clearError();
    lastAudio = null;
    syncActions();
    syncPlaybackUi();

    const chunks = splitForSpeech(text);
    const total = Math.max(1, chunks.length);
    setProgress(0.02);

    try {
      const parts = /** @type {Float32Array[]} */ ([]);
      const result = await engine.generate(text, {
        voice: els.voice.value,
        speed: Number(els.speed.value) || 1,
        signal: abort.signal,
        onChunk: ({ audio, sampleRate, index }) => {
          parts.push(audio);
          lastRate = sampleRate;
          setProgress((index + 1) / total);
          setStatus(`Speaking… ${index + 1}/${total}`);
          enqueuePlay(audio, sampleRate);
        },
      });

      lastAudio = result.audio.length ? result.audio : concatAudio(parts);
      lastRate = result.sampleRate || lastRate;
      replayOffset = 0;
      setProgress(1);
      setBusy(false, 'Done.');
      els.status.classList.add('is-ok');
      els.meta.hidden = false;
      els.meta.textContent = `${formatDuration(lastAudio.length / lastRate)} · ${result.chunks} chunk${result.chunks === 1 ? '' : 's'} · ${els.voice.value}`;
      syncActions();
      syncPlaybackUi();
    } catch (err) {
      if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
        setBusy(false, 'Stopped.');
      } else {
        setBusy(false, 'Could not speak.');
        showError(friendlyError(err));
      }
    } finally {
      streaming = false;
      els.livePill.classList.remove('is-on');
      wave.setMode('idle');
      wave.setLive(null);
      abort = null;
      hideProgressSoon();
      syncActions();
      syncPlaybackUi();
    }
  }

  function stopAll() {
    abort?.abort();
    stopPlayback(true);
    els.livePill.classList.remove('is-on');
    wave.setMode('idle');
    wave.setLive(null);
    if (busy) {
      setBusy(false, 'Stopped.');
    }
    syncActions();
    syncPlaybackUi();
  }

  async function toggleReplay() {
    if (!lastAudio || streaming || busy) {
      return;
    }
    if (replayPlaying && !replayPaused) {
      pauseReplay();
      return;
    }
    if (replayPaused) {
      await resumeReplay();
      return;
    }
    await startReplay(replayOffset);
  }

  /**
   * @param {number} [fromRatio]
   */
  async function startReplay(fromRatio = 0) {
    if (!lastAudio) {
      return;
    }
    stopStreamQueue();
    ensureAudio();
    if (!playCtx || !analyser) {
      return;
    }
    if (playCtx.state === 'suspended') {
      await playCtx.resume();
    }

    const dur = lastAudio.length / lastRate;
    const startSec = Math.min(Math.max(0, fromRatio), 0.999) * dur;
    const startSample = Math.floor(startSec * lastRate);
    const pcm = lastAudio.subarray(startSample);
    if (!pcm.length) {
      replayOffset = 0;
      syncPlaybackUi();
      return;
    }

    const buffer = playCtx.createBuffer(1, pcm.length, lastRate);
    buffer.copyToChannel(pcm, 0);
    const source = playCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    analyser.connect(playCtx.destination);
    playSource = source;
    replayPlaying = true;
    replayPaused = false;
    replayOffset = startSec / dur;
    replayStartedAt = playCtx.currentTime - startSec;
    source.start();
    startAnalyse();
    startClock();
    syncActions();
    syncPlaybackUi();

    source.onended = () => {
      if (playSource !== source) {
        return;
      }
      playSource = null;
      replayPlaying = false;
      replayPaused = false;
      replayOffset = 0;
      stopAnalyse();
      stopClock();
      wave.setMode('idle');
      wave.setLive(null);
      syncActions();
      syncPlaybackUi();
    };
  }

  function pauseReplay() {
    if (!replayPlaying || !playCtx || replayPaused) {
      return;
    }
    const dur = lastAudio ? lastAudio.length / lastRate : 0;
    if (dur > 0) {
      replayOffset = Math.min(0.999, Math.max(0, (playCtx.currentTime - replayStartedAt) / dur));
    }
    try {
      playSource?.stop();
    } catch {
      /* ignore */
    }
    playSource = null;
    replayPaused = true;
    replayPlaying = false;
    stopAnalyse();
    stopClock();
    wave.setMode('idle');
    wave.setLive(null);
    syncActions();
    syncPlaybackUi();
  }

  async function resumeReplay() {
    await startReplay(replayOffset);
  }

  /**
   * @param {number} ratio
   */
  function seekReplay(ratio) {
    replayOffset = Math.min(1, Math.max(0, ratio));
    if (replayPlaying || replayPaused) {
      void startReplay(replayOffset);
      return;
    }
    syncPlaybackUi();
  }

  /**
   * @param {Float32Array} pcm
   * @param {number} rate
   */
  function enqueuePlay(pcm, rate) {
    playQueue.push({ pcm, rate });
    void pumpPlay();
  }

  async function pumpPlay() {
    if (playPump) {
      return;
    }
    playPump = true;
    try {
      while (playQueue.length) {
        const next = playQueue.shift();
        if (!next) {
          break;
        }
        await playChunk(next.pcm, next.rate);
      }
    } finally {
      playPump = false;
    }
  }

  /**
   * @param {Float32Array} pcm
   * @param {number} rate
   */
  async function playChunk(pcm, rate) {
    ensureAudio();
    if (!playCtx || !analyser) {
      return;
    }
    if (playCtx.state === 'suspended') {
      await playCtx.resume();
    }
    const buffer = playCtx.createBuffer(1, pcm.length, rate);
    buffer.copyToChannel(pcm, 0);
    const source = playCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    analyser.connect(playCtx.destination);
    playSource = source;
    source.start();
    startAnalyse();
    await new Promise((resolve) => {
      source.onended = () => resolve(undefined);
    });
  }

  function ensureAudio() {
    if (playCtx) {
      return;
    }
    playCtx = new AudioContext();
    analyser = playCtx.createAnalyser();
    analyser.fftSize = 256;
  }

  function startAnalyse() {
    if (!analyser) {
      return;
    }
    wave.setMode('speaking');
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!analyser) {
        return;
      }
      analyser.getByteFrequencyData(data);
      wave.setLive(data);
      analyseWatch = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(analyseWatch);
    analyseWatch = requestAnimationFrame(tick);
  }

  function stopAnalyse() {
    cancelAnimationFrame(analyseWatch);
    analyseWatch = 0;
  }

  function startClock() {
    stopClock();
    const tick = () => {
      syncPlaybackUi();
      clockWatch = requestAnimationFrame(tick);
    };
    clockWatch = requestAnimationFrame(tick);
  }

  function stopClock() {
    cancelAnimationFrame(clockWatch);
    clockWatch = 0;
  }

  function stopStreamQueue() {
    playQueue = [];
    try {
      playSource?.stop();
    } catch {
      /* ignore */
    }
    playSource = null;
  }

  /**
   * @param {boolean} [resetOffset]
   */
  function stopPlayback(resetOffset = false) {
    stopStreamQueue();
    stopAnalyse();
    stopClock();
    playPump = false;
    streaming = false;
    replayPlaying = false;
    replayPaused = false;
    if (resetOffset) {
      replayOffset = 0;
    }
    wave.setLive(null);
  }

  function downloadWav() {
    if (!lastAudio) {
      return;
    }
    const buf = encodeWav(lastAudio, lastRate);
    const blob = new Blob([buf], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `speakasm-${Date.now()}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearAll() {
    stopAll();
    els.input.value = '';
    lastAudio = null;
    replayOffset = 0;
    els.meta.hidden = true;
    els.meta.textContent = '';
    els.playback.classList.remove('is-active');
    clearError();
    updateCharCount();
    syncActions();
    syncPlaybackUi();
    setStatus('Ready when you are.');
    els.status.classList.add('is-ok');
  }

  async function onFile() {
    const file = els.file.files && els.file.files[0];
    els.file.value = '';
    if (!file) {
      return;
    }
    await ingestFile(file);
  }

  /**
   * @param {File} file
   */
  async function ingestFile(file) {
    setBusy(true, `Reading ${file.name}...`);
    wave.setMode('loading');
    clearError();
    try {
      const { text, source } = await extractFromFile(file);
      if (!text) {
        throw new Error('No readable text in that file.');
      }
      els.input.value = text;
      updateCharCount();
      syncActions();
      setBusy(false, `Loaded ${source}.`);
      els.status.classList.add('is-ok');
      els.meta.hidden = false;
      els.meta.textContent = `${source} · ${text.length.toLocaleString()} characters`;
    } catch (err) {
      setBusy(false, 'Could not read file.');
      showError(friendlyError(err));
    } finally {
      wave.setMode('idle');
    }
  }

  async function saveOffline() {
    setBusy(true, 'Saving offline assets...');
    try {
      const urls = await collectOfflineUrls();
      await cacheModelUrls(urls, (done, total) => {
        setProgress(done / Math.max(1, total));
        setStatus(`Saving offline… ${done}/${total}`);
      });
      setBusy(false, 'Saved for offline use.');
      els.status.classList.add('is-ok');
      setProgress(1);
      hideProgressSoon();
    } catch (err) {
      setBusy(false, 'Offline save failed.');
      showError(friendlyError(err));
      hideProgressSoon();
    }
  }

  /**
   * @returns {Promise<string[]>}
   */
  async function collectOfflineUrls() {
    const urls = [
      '/vendor/kokoro/kokoro.js',
      '/voices.json',
      '/models/Kokoro-82M-v1.0-ONNX/config.json',
      '/models/Kokoro-82M-v1.0-ONNX/tokenizer.json',
      '/models/Kokoro-82M-v1.0-ONNX/tokenizer_config.json',
      '/models/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx',
    ];
    for (const v of voices) {
      urls.push(`/models/Kokoro-82M-v1.0-ONNX/voices/${v.id}.bin`);
    }
    try {
      const res = await fetch('/vendor/kokoro/manifest.json', { credentials: 'same-origin' });
      if (res.ok) {
        const man = await res.json();
        if (Array.isArray(man.files)) {
          for (const f of man.files) {
            urls.push(`/vendor/kokoro/${f}`);
          }
        }
      }
    } catch {
      /* optional */
    }
    return [...new Set(urls)];
  }

  function wireDrop() {
    const onDrag = (ev) => {
      ev.preventDefault();
    };
    window.addEventListener('dragenter', (ev) => {
      onDrag(ev);
      dragDepth += 1;
      els.dropOverlay.hidden = false;
      els.dropOverlay.classList.add('is-on');
      els.dropOverlay.setAttribute('aria-hidden', 'false');
    });
    window.addEventListener('dragleave', (ev) => {
      onDrag(ev);
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        els.dropOverlay.hidden = true;
        els.dropOverlay.classList.remove('is-on');
        els.dropOverlay.setAttribute('aria-hidden', 'true');
      }
    });
    window.addEventListener('dragover', onDrag);
    window.addEventListener('drop', (ev) => {
      onDrag(ev);
      dragDepth = 0;
      els.dropOverlay.hidden = true;
      els.dropOverlay.classList.remove('is-on');
      els.dropOverlay.setAttribute('aria-hidden', 'true');
      const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file) {
        void ingestFile(file);
      }
    });
  }

  function updateCharCount() {
    const n = els.input.value.length;
    els.charCount.textContent = `${n.toLocaleString()} chars`;
  }

  function syncActions() {
    const hasText = cleanText(els.input.value).length > 0;
    const audible = Boolean(playSource) || replayPlaying || playQueue.length > 0;
    els.btnSpeak.disabled = busy || !hasText;
    els.btnStop.disabled = !busy && !audible && !replayPaused;
    els.btnPlay.disabled = !lastAudio || busy || streaming;
    els.btnDownload.disabled = !lastAudio;
    els.btnClear.disabled = busy || (!els.input.value && !lastAudio);
    els.scrub.disabled = !lastAudio || busy || streaming;
  }

  function syncPlaybackUi() {
    const dur = lastAudio ? lastAudio.length / lastRate : 0;
    let cur = 0;
    if (lastAudio && replayPlaying && playCtx && !scrubbing) {
      cur = Math.min(dur, Math.max(0, playCtx.currentTime - replayStartedAt));
      replayOffset = dur > 0 ? cur / dur : 0;
    } else if (lastAudio) {
      cur = replayOffset * dur;
    }

    els.timeCur.textContent = formatDuration(cur);
    els.timeTotal.textContent = formatDuration(dur);
    if (!scrubbing) {
      els.scrub.value = String(Math.round((dur > 0 ? cur / dur : 0) * 1000));
    }

    if (replayPlaying && !replayPaused) {
      els.btnPlay.textContent = 'Pause';
      els.btnPlay.setAttribute('aria-label', 'Pause');
      els.playback.classList.add('is-playing');
    } else {
      els.btnPlay.textContent = 'Play';
      els.btnPlay.setAttribute('aria-label', 'Play');
      els.playback.classList.remove('is-playing');
    }

    if (lastAudio || streaming || busy) {
      els.playback.classList.add('is-active');
    }
  }

  /**
   * @param {boolean} on
   * @param {string} msg
   */
  function setBusy(on, msg) {
    busy = on;
    els.spinner.hidden = !on;
    setStatus(msg);
    els.status.classList.toggle('is-ok', !on);
    syncActions();
  }

  /**
   * @param {string} msg
   */
  function setStatus(msg) {
    els.status.textContent = msg;
  }

  /**
   * @param {number} ratio
   */
  function setProgress(ratio) {
    els.progressTrack.hidden = false;
    els.progress.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  }

  function hideProgressSoon() {
    window.setTimeout(() => {
      if (!busy) {
        els.progressTrack.hidden = true;
        els.progress.style.width = '0%';
      }
    }, 700);
  }

  function clearError() {
    els.error.hidden = true;
    els.error.textContent = '';
  }

  /**
   * @param {string} msg
   */
  function showError(msg) {
    els.error.hidden = false;
    els.error.textContent = msg;
  }

  /**
   * @param {unknown} err
   * @returns {string}
   */
  function friendlyError(err) {
    const msg = err && typeof err === 'object' && 'message' in err
      ? String(/** @type {{ message: string }} */ (err).message)
      : String(err || 'Unknown error');
    if (/fetch|network|Failed to load/i.test(msg)) {
      return 'Missing local model assets. Run make assets, then refresh.';
    }
    return msg;
  }

  /**
   * @param {number} seconds
   */
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '0:00';
    }
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
