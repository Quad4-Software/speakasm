/**
 * Ambient waveform canvas for the hero visual.
 */

/** @typedef {'idle' | 'speaking' | 'loading'} WaveMode */

const PALETTE = {
  idle: {
    ink: 'rgba(236, 236, 240, 0.22)',
    accent: 'rgba(232, 176, 120, 0.45)',
    live: 'rgba(255, 220, 170, 0.95)',
    speed: 0.018,
  },
  speaking: {
    ink: 'rgba(236, 220, 190, 0.22)',
    accent: 'rgba(232, 176, 120, 0.62)',
    live: 'rgba(255, 230, 180, 0.95)',
    speed: 0.034,
  },
  loading: {
    ink: 'rgba(200, 210, 220, 0.2)',
    accent: 'rgba(140, 170, 190, 0.5)',
    live: 'rgba(190, 220, 240, 0.9)',
    speed: 0.024,
  },
};

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createWaveController(canvas) {
  const ctx = canvas.getContext('2d');
  let raf = 0;
  let phase = 0;
  /** @type {Uint8Array | null} */
  let live = null;
  let reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** @type {WaveMode} */
  let mode = 'idle';

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth || canvas.width;
    const height = Math.max(56, Math.min(96, Math.round(width * 0.12)));
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  /**
   * @param {number} t
   */
  function draw(t) {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || 160;
    ctx.clearRect(0, 0, w, h);
    const pal = PALETTE[mode];
    phase += pal.speed;

    const mid = h * 0.52;
    const bars = Math.max(48, Math.floor(w / 10));
    for (let i = 0; i < bars; i++) {
      const x = (i / bars) * w;
      const n = Math.sin(phase + i * 0.28) * 0.5 + Math.sin(phase * 1.7 + i * 0.11) * 0.5;
      let amp = 0.18 + Math.abs(n) * 0.35;
      if (live && live.length) {
        const li = Math.floor((i / bars) * live.length);
        amp = Math.max(amp, (live[li] / 255) * 0.92);
      }
      const bh = amp * h * 0.72;
      ctx.fillStyle = i % 3 === 0 ? pal.live : i % 2 === 0 ? pal.accent : pal.ink;
      ctx.fillRect(x, mid - bh * 0.55, Math.max(2, w / bars - 3), bh);
    }

    if (!reduced) {
      raf = requestAnimationFrame(draw);
    }
  }

  function start() {
    resize();
    cancelAnimationFrame(raf);
    raf = 0;
    if (reduced || document.hidden) {
      draw(0);
      return;
    }
    raf = requestAnimationFrame(draw);
  }

  function stopLoop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  window.addEventListener('resize', () => {
    resize();
    if (reduced || document.hidden) {
      draw(0);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopLoop();
      return;
    }
    if (!reduced) {
      start();
    }
  });

  return {
    start,
    /**
     * @param {WaveMode} next
     */
    setMode(next) {
      mode = next;
    },
    /**
     * @param {Uint8Array | null} data
     */
    setLive(data) {
      live = data;
    },
  };
}
