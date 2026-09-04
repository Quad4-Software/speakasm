const $ = (id) => document.getElementById(id);
const status = $("status");
function setStatus(msg) { status.textContent = msg || ""; }
async function send(msg) { return chrome.runtime.sendMessage(msg); }

const settings = await send({ type: "get-settings" });
if (settings?.bridgeOrigin) $("bridge").value = settings.bridgeOrigin;
if (settings?.speed) {
  $("speed").value = settings.speed;
  $("speed-val").textContent = Number(settings.speed).toFixed(2);
}

$("speed").addEventListener("input", () => {
  $("speed-val").textContent = Number($("speed").value).toFixed(2);
});
$("speed").addEventListener("change", persist);
$("voice").addEventListener("change", persist);
$("bridge").addEventListener("change", persist);

async function persist() {
  await send({
    type: "save-settings",
    settings: {
      voice: $("voice").value,
      speed: Number($("speed").value),
      bridgeOrigin: $("bridge").value.trim() || undefined,
    },
  });
}

setStatus("Loading voices…");
await send({ type: "ensure-bridge" });
const voicesRes = await send({ type: "list-voices" });
const voices = voicesRes?.result?.voices || [];
const sel = $("voice");
sel.innerHTML = "";
for (const v of voices) {
  const opt = document.createElement("option");
  opt.value = v.id;
  opt.textContent = `${v.label} (${v.locale || ""} ${v.gender || ""})`.trim();
  if (v.default) opt.selected = true;
  sel.appendChild(opt);
}
if (settings?.voice) sel.value = settings.voice;
setStatus(voices.length ? "Ready" : "Connect bridge to load voices");

$("btn-bridge").addEventListener("click", async () => {
  await persist();
  setStatus("Opening bridge…");
  const res = await send({ type: "ensure-bridge" });
  setStatus(res?.ok ? "Bridge ready." : (res?.error || "Failed"));
});

$("btn-speak").addEventListener("click", async () => {
  await persist();
  const text = $("input").value;
  if (!text.trim()) return;
  setStatus("Speaking…");
  const res = await send({
    type: "speak-text",
    text,
    voice: $("voice").value,
    speed: Number($("speed").value),
  });
  setStatus(res?.ok ? "Done" : (res?.error || "Error"));
});

$("btn-stop").addEventListener("click", async () => {
  const res = await send({ type: "stop-speak" });
  setStatus(res?.ok ? "Stopped" : (res?.error || "Error"));
});

$("btn-sel").addEventListener("click", async () => {
  await persist();
  setStatus("Speaking selection…");
  const res = await send({ type: "speak-selection" });
  setStatus(res?.ok ? "Done" : (res?.error || "Error"));
});

$("btn-page").addEventListener("click", async () => {
  await persist();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) {
    try { await chrome.permissions.request({ origins: [new URL(tab.url).origin + "/*"] }); } catch {}
  }
  setStatus("Speaking page…");
  const res = await send({ type: "speak-page" });
  setStatus(res?.ok ? "Done" : (res?.error || "Error"));
});
