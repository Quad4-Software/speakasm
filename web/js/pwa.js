/**
 * Register the service worker, enable COOP/COEP isolation, and auto-apply updates.
 */

const UPDATE_TOAST_ID = 'pwa-update-toast';
const COI_RELOAD_KEY = 'speakasm-coi-reload';

/**
 * @returns {Promise<void>}
 */
export async function registerPWA() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    wireAutoUpdate(reg);
    await ensureCrossOriginIsolated();
  } catch (err) {
    console.warn('PWA registration failed', err);
  }
}

/**
 * @param {{
 *   installBtn: HTMLButtonElement,
 *   iosTipBtn: HTMLButtonElement,
 *   iosTipPanel: HTMLElement,
 * }} els
 */
export function setupInstallAffordance(els) {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    /** @type {any} */ (navigator).standalone === true;

  if (standalone) {
    els.installBtn.hidden = true;
    els.iosTipBtn.hidden = true;
    els.iosTipPanel.hidden = true;
    return;
  }

  /** @type {any} */
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    deferred = ev;
    els.installBtn.hidden = false;
  });

  els.installBtn.addEventListener('click', async () => {
    if (!deferred) {
      return;
    }
    els.installBtn.hidden = true;
    deferred.prompt();
    try {
      await deferred.userChoice;
    } catch {
      /* ignore */
    }
    deferred = null;
  });

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isSafari = /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);
  if (isIos && isSafari) {
    els.iosTipBtn.hidden = false;
    els.iosTipBtn.addEventListener('click', () => {
      els.iosTipPanel.hidden = !els.iosTipPanel.hidden;
    });
  }
}

/**
 * Ask the service worker to cache model URLs in the asset cache.
 * @param {string[]} urls
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function cacheModelUrls(urls, onProgress) {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Offline saving needs a service worker.');
  }
  const reg = await navigator.serviceWorker.ready;
  const worker = reg.active || navigator.serviceWorker.controller;
  if (!worker) {
    throw new Error('Service worker is not active yet. Refresh once.');
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (ev) => {
      const data = ev.data || {};
      if (data.type === 'CACHE_PROGRESS') {
        onProgress?.(data.done | 0, data.total | 0);
        return;
      }
      if (data.type === 'CACHE_DONE') {
        resolve(undefined);
        return;
      }
      if (data.type === 'CACHE_ERROR') {
        reject(new Error(data.error || 'Could not cache models.'));
      }
    };
    worker.postMessage({ type: 'CACHE_URLS', urls }, [channel.port2]);
  });
}

/**
 * @param {ServiceWorkerRegistration} reg
 */
function wireAutoUpdate(reg) {
  let refreshing = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) {
      return;
    }
    if (!globalThis.crossOriginIsolated) {
      return;
    }
    refreshing = true;
    showUpdateToast('Updating...');
    window.location.reload();
  });

  const askWaiting = () => {
    if (reg.waiting) {
      showUpdateToast('Updating...');
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  };

  askWaiting();

  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    if (!worker) {
      return;
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') {
        if (navigator.serviceWorker.controller) {
          showUpdateToast('Updating...');
          (reg.waiting || worker).postMessage({ type: 'SKIP_WAITING' });
        }
      }
    });
  });

  const check = () => {
    if (!navigator.onLine) {
      return;
    }
    reg.update().catch(() => {});
  };

  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      check();
    }
  });
  window.addEventListener('focus', check);
  setInterval(check, 60 * 1000);
  check();
}

/**
 * Pages hosts lack COOP/COEP. After the SW injects them, reload once so the
 * document becomes crossOriginIsolated and SharedArrayBuffer works.
 * @returns {Promise<void>}
 */
async function ensureCrossOriginIsolated() {
  if (globalThis.crossOriginIsolated) {
    sessionStorage.removeItem(COI_RELOAD_KEY);
    return;
  }

  if (!navigator.serviceWorker.controller) {
    await Promise.race([
      new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      }),
      new Promise((resolve) => {
        setTimeout(resolve, 4000);
      }),
    ]);
  }

  if (globalThis.crossOriginIsolated) {
    sessionStorage.removeItem(COI_RELOAD_KEY);
    return;
  }

  const attempts = Number(sessionStorage.getItem(COI_RELOAD_KEY) || '0');
  if (attempts >= 2) {
    console.warn('cross-origin isolation unavailable after reload');
    return;
  }

  sessionStorage.setItem(COI_RELOAD_KEY, String(attempts + 1));
  showUpdateToast('Updating...');
  window.location.reload();
  await new Promise(() => {});
}

/**
 * @param {string} text
 */
function showUpdateToast(text) {
  let el = document.getElementById(UPDATE_TOAST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = UPDATE_TOAST_ID;
    el.className = 'pwa-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.setAttribute('class', 'pwa-toast is-on');
}
