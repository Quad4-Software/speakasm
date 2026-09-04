/**
 * Service worker for speakasm.
 * Keeps a bridge tab on the PWA origin for isolated Kokoro TTS.
 */

const APP_ORIGIN = "https://speakasm.quad4.io";
const APP_NAME = "speakasm";
const BRIDGE_PATH = "/extension-bridge.html";
const BRIDGE_NAME = "speakasm-bridge";

const pending = new Map();
let reqSeq = 0;

async function getConfiguredOrigin() {
  const settings = await getSettings();
  return String(settings.bridgeOrigin || settings.siteOrigin || APP_ORIGIN).replace(/\/$/, "");
}

async function getSiteOrigin() {
  const settings = await getSettings();
  return String(settings.siteOrigin || APP_ORIGIN).replace(/\/$/, "");
}

function isAllowedBridgeUrl(url, origin, siteOrigin) {
  return (
    url.startsWith(APP_ORIGIN) ||
    url.startsWith(origin) ||
    (siteOrigin && url.startsWith(siteOrigin)) ||
    url.startsWith("http://127.0.0.1") ||
    url.startsWith("http://localhost")
  );
}

async function getBridgePort() {
  if (globalThis.__bridgePort && globalThis.__bridgePort.name === BRIDGE_NAME) {
    return globalThis.__bridgePort;
  }
  await ensureBridgeTab();
  for (let i = 0; i < 40; i++) {
    if (globalThis.__bridgePort && globalThis.__bridgePort.name === BRIDGE_NAME) {
      return globalThis.__bridgePort;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function ensureBridgeTab() {
  const origin = await getConfiguredOrigin();
  const extId = chrome.runtime.id;
  const url = `${origin}${BRIDGE_PATH}?extId=${encodeURIComponent(extId)}`;

  const tabs = await chrome.tabs.query({ url: `${origin}${BRIDGE_PATH}*` });
  if (tabs.length) {
    const existing = tabs[0];
    if (existing.url !== url) {
      await chrome.tabs.update(existing.id, { url });
    }
    await chrome.storage.session.set({ bridgeTabId: existing.id });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url, active: false });
  await chrome.storage.session.set({ bridgeTabId: tab.id });
  return tab.id;
}

async function bridgeRequest(payload) {
  const port = await getBridgePort();
  if (!port) throw new Error("Bridge not connected. Allow the bridge tab to stay open.");
  const id = `r${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("bridge timeout"));
    }, 300000);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ ...payload, id });
  });
}

chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== BRIDGE_NAME) {
    port.disconnect();
    return;
  }
  const url = port.sender?.url || "";
  Promise.all([getConfiguredOrigin(), getSiteOrigin()]).then(([origin, siteOrigin]) => {
    if (!isAllowedBridgeUrl(url, origin, siteOrigin)) {
      port.disconnect();
      return;
    }
    globalThis.__bridgePort = port;
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "bridge-hello") return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || "bridge error"));
    });
    port.onDisconnect.addListener(() => {
      if (globalThis.__bridgePort === port) globalThis.__bridgePort = null;
    });
  });
});

async function getSettings() {
  const defaults = {
    siteOrigin: APP_ORIGIN,
    bridgeOrigin: APP_ORIGIN,
    syncBridge: true,
    autoUpdateCheck: true,
    voice: "af_heart",
    speed: 1,
    remoteVersion: "",
    updateAvailable: false,
  };
  const stored = await chrome.storage.sync.get(defaults);
  const merged = { ...defaults, ...stored };
  if (merged.syncBridge !== false) {
    merged.bridgeOrigin = merged.siteOrigin || APP_ORIGIN;
  }
  return merged;
}


function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d > 0) return 1;
    if (d < 0) return -1;
  }
  return 0;
}

async function ensureHostAccess(origin) {
  const o = String(origin || "").replace(/\/$/, "");
  if (!o || o === APP_ORIGIN) return true;
  if (o.startsWith("http://127.0.0.1") || o.startsWith("http://localhost")) return true;
  try {
    const ok = await chrome.permissions.contains({ origins: [`${o}/*`] });
    if (ok) return true;
    return await chrome.permissions.request({ origins: [`${o}/*`] });
  } catch {
    return false;
  }
}

async function scheduleUpdateAlarm(enabled) {
  if (!chrome.alarms) return;
  await chrome.alarms.clear("check-updates");
  if (enabled) {
    await chrome.alarms.create("check-updates", { periodInMinutes: 1440 });
  }
}

async function checkForUpdates(opts = {}) {
  const settings = await getSettings();
  const siteOrigin = String(settings.siteOrigin || APP_ORIGIN).replace(/\/$/, "");
  const allowed = await ensureHostAccess(siteOrigin);
  if (!allowed) throw new Error("Host permission required for " + siteOrigin);

  const localVersion = chrome.runtime.getManifest().version;
  const res = await fetch(`${siteOrigin}/build/manifest.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Update manifest HTTP ${res.status}`);
  const remote = await res.json();
  const remoteVersion = String(remote?.version || "");
  const updateAvailable = Boolean(remoteVersion) && compareVersions(remoteVersion, localVersion) > 0;

  await chrome.storage.sync.set({
    remoteVersion,
    updateAvailable,
    lastUpdateCheck: Date.now(),
  });

  if (updateAvailable && opts.notify !== false) {
    try {
      await chrome.action.setBadgeText({ text: "UP" });
      await chrome.action.setBadgeBackgroundColor({ color: "#8ad0c6" });
      await chrome.notifications.create("ext-update", {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: `${APP_NAME} update available`,
        message: `Version ${remoteVersion} is ready at ${siteOrigin}/build/`,
      });
    } catch {
      // notifications optional
    }
  } else if (!updateAvailable) {
    try {
      await chrome.action.setBadgeText({ text: "" });
    } catch {
      // ignore
    }
  }

  let browserUpdate = null;
  if (chrome.runtime.requestUpdateCheck) {
    try {
      browserUpdate = await chrome.runtime.requestUpdateCheck();
    } catch {
      browserUpdate = null;
    }
  }

  return {
    localVersion,
    remoteVersion,
    updateAvailable,
    siteOrigin,
    browserUpdate,
    message: updateAvailable
      ? `Update available: ${remoteVersion}`
      : "You are up to date.",
  };
}


chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await scheduleUpdateAlarm(settings.autoUpdateCheck !== false);
  checkForUpdates({ notify: false }).catch(() => {});
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "speak-selection",
    title: "Speak with speakasm",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "speak-page",
    title: "Speak page with speakasm",
    contexts: ["page"],
  });
});

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping-content" });
    return;
  } catch {
    // not injected yet
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/content.js"],
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content/content.css"],
  });
}

async function speakText(text, voice, speed) {
  return bridgeRequest({
    type: "speak",
    text,
    voice,
    speed,
  });
}

async function speakSelection(tabId) {
  await ensureContentScript(tabId);
  const sel = await chrome.tabs.sendMessage(tabId, { type: "get-selection" });
  if (!sel?.text?.trim()) throw new Error("No selection");
  const settings = await getSettings();
  await speakText(sel.text, settings.voice, settings.speed);
}

async function speakPage(tabId) {
  await ensureContentScript(tabId);
  const collected = await chrome.tabs.sendMessage(tabId, { type: "collect-page-text" });
  const chunks = collected?.chunks || [];
  if (!chunks.length) throw new Error("No page text found");
  const text = chunks.join("\n\n").slice(0, 8000);
  const settings = await getSettings();
  await chrome.tabs.sendMessage(tabId, { type: "show-toast", text: "Speaking page…", mode: "info" });
  await speakText(text, settings.voice, settings.speed);
  await chrome.tabs.sendMessage(tabId, { type: "show-toast", text: "Done speaking.", mode: "ok" });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === "speak-selection" && info.selectionText) {
      const settings = await getSettings();
      await speakText(info.selectionText, settings.voice, settings.speed);
    } else if (info.menuItemId === "speak-page" && tab?.id) {
      await speakPage(tab.id);
    }
  } catch (err) {
    if (tab?.id) {
      await ensureContentScript(tab.id).catch(() => {});
      await chrome.tabs.sendMessage(tab.id, {
        type: "show-toast",
        text: String(err?.message || err),
        mode: "error",
      }).catch(() => {});
    }
  }
});

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      if (command === "speak-selection") await speakSelection(tab.id);
    } catch (err) {
      await ensureContentScript(tab.id).catch(() => {});
      await chrome.tabs.sendMessage(tab.id, {
        type: "show-toast",
        text: String(err?.message || err),
        mode: "error",
      }).catch(() => {});
    }
  });
}

chrome.runtime.onStartup?.addListener?.(async () => {
  const settings = await getSettings();
  await scheduleUpdateAlarm(settings.autoUpdateCheck !== false);
  if (settings.autoUpdateCheck !== false) {
    checkForUpdates({ notify: true }).catch(() => {});
  }
});

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "check-updates") return;
    checkForUpdates({ notify: true }).catch(() => {});
  });
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener(async (id) => {
    if (id !== "ext-update") return;
    const siteOrigin = await getSiteOrigin();
    await chrome.tabs.create({ url: `${siteOrigin}/build/` });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "ensure-bridge") {
      await ensureBridgeTab();
      await getBridgePort();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "get-settings") {
      sendResponse(await getSettings());
      return;
    }
    if (msg?.type === "save-settings") {
      const next = { ...(msg.settings || {}) };
      if (next.siteOrigin) {
        next.siteOrigin = String(next.siteOrigin).replace(/\/$/, "");
        const ok = await ensureHostAccess(next.siteOrigin);
        if (!ok) throw new Error("Permission denied for site origin");
      }
      if (next.bridgeOrigin) {
        next.bridgeOrigin = String(next.bridgeOrigin).replace(/\/$/, "");
        const ok = await ensureHostAccess(next.bridgeOrigin);
        if (!ok) throw new Error("Permission denied for bridge origin");
      }
      if (next.syncBridge !== false && next.siteOrigin) {
        next.bridgeOrigin = next.siteOrigin;
      }
      await chrome.storage.sync.set(next);
      const settings = await getSettings();
      await scheduleUpdateAlarm(settings.autoUpdateCheck !== false);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "check-updates") {
      const result = await checkForUpdates({ notify: Boolean(msg.force) });
      sendResponse({ ok: true, ...result });
      return;
    }
    if (msg?.type === "open-options") {
      if (chrome.runtime.openOptionsPage) await chrome.runtime.openOptionsPage();
      else await chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") });
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "list-voices") {
      const result = await bridgeRequest({ type: "list-voices" });
      sendResponse({ ok: true, result });
      return;
    }
    if (msg?.type === "speak-text") {
      const settings = await getSettings();
      await speakText(
        msg.text,
        msg.voice || settings.voice,
        msg.speed != null ? msg.speed : settings.speed,
      );
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "stop-speak") {
      await bridgeRequest({ type: "stop" });
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "speak-selection") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      await speakSelection(tab.id);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "speak-page") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      await speakPage(tab.id);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "open-app") {
      const siteOrigin = await getSiteOrigin();
      await chrome.tabs.create({ url: siteOrigin + "/" });
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "unknown" });
  })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
