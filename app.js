// Dumbrava Translate (телефон): режим «Прослушка».
// Микрофон телефона → Gemini Live Translate → перевод в наушники + субтитры.
import {
  Translator, Resampler, Chunker, PauseTrimmer, floatToPcm16, pcm16ToFloat, levelPercent,
  LANGUAGES, IN_RATE, OUT_RATE, CHUNK_SAMPLES,
} from "./core.js";

const $ = (id) => document.getElementById(id);
const KEY_STORE = "dumbrava.key", SET_STORE = "dumbrava.settings", USE_STORE = "dumbrava.usage";
const SEGMENT_IDLE_MS = 2500, MAX_LINES = 40;

// ---------------------------------------------------------------- настройки
const defaults = { lang: "ru", volume: 100, showOrig: true, noise: true, noPhones: false, wake: true, rotateMin: 8 };
let S = { ...defaults };
try { S = { ...defaults, ...JSON.parse(localStorage.getItem(SET_STORE) || "{}") }; } catch { /* пусто */ }
const saveSettings = () => localStorage.setItem(SET_STORE, JSON.stringify(S));
const getKey = () => (localStorage.getItem(KEY_STORE) || "").trim();

// ---------------------------------------------------------------- учёт расхода
const today = () => new Date().toISOString().slice(0, 10);
function usage() { try { return JSON.parse(localStorage.getItem(USE_STORE) || "{}"); } catch { return {}; } }
let U = usage(), usageDirty = false;
function addUsage(field, v) {
  const d = (U[today()] ||= { in_s: 0, out_s: 0, sessions: 0, tokens: 0 });
  d[field] += v; usageDirty = true;
}
setInterval(() => { if (usageDirty) { localStorage.setItem(USE_STORE, JSON.stringify(U)); usageDirty = false; } showUsage(); }, 2000);
const num = (v, d = 1) => v.toFixed(d).replace(".", ",");
function showUsage() {
  const d = U[today()] || { in_s: 0, out_s: 0, sessions: 0 };
  const m = d.in_s / 60;
  $("statToday").textContent = m < 10 ? `${num(m)} мин` : `${Math.round(m)} мин`;
  $("usageText").textContent = `${num(m)} мин звука отправлено · ${num(d.out_s / 60)} мин перевода · ${d.sessions} сеанс(ов)`;
}

// ---------------------------------------------------------------- экран
function fillLangs(sel) {
  for (const [code, name] of LANGUAGES) {
    const o = document.createElement("option"); o.value = code; o.textContent = name; sel.appendChild(o);
  }
  sel.value = S.lang;
}
fillLangs($("lang")); fillLangs($("lang2"));
for (const id of ["lang", "lang2"]) {
  $(id).addEventListener("change", (e) => {
    S.lang = e.target.value; $("lang").value = $("lang2").value = S.lang; saveSettings();
    if (running) toast("Язык сменится при следующем запуске перевода.");
  });
}

const STATES = { idle: "Готов", connecting: "Подключение…", running: "Слушаю", error: "Ошибка" };
function setState(st, text) {
  const p = $("pill"); p.className = "pill " + st; p.textContent = text || STATES[st];
}

let toastTimer = 0;
function toast(msg, isError = false, ms = 4000) {
  const t = $("toast"); t.textContent = msg; t.className = "toast" + (isError ? " error" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// субтитры: каждая фраза — блок «перевод + оригинал»
let cur = null, lastFrag = 0;
function ensureLine() {
  if (cur) return cur;
  $("empty")?.remove();
  const el = document.createElement("article"); el.className = "line";
  el.innerHTML = '<p class="dst"></p><p class="src"></p>';
  $("feed").appendChild(el);
  while ($("feed").children.length > MAX_LINES) $("feed").firstElementChild.remove();
  cur = { el, dst: el.querySelector(".dst"), src: el.querySelector(".src") };
  return cur;
}
function addText(kind, text) {
  const l = ensureLine(); lastFrag = Date.now();
  const node = kind === "in" ? l.src : l.dst;
  node.textContent = (node.textContent + text).replace(/\s+/g, " ").trimStart();
  const f = $("feed"); f.scrollTop = f.scrollHeight;
}
function finishLine() { cur = null; }
setInterval(() => { if (cur && Date.now() - lastFrag > SEGMENT_IDLE_MS) finishLine(); }, 500);
document.body.classList.toggle("hide-orig", !S.showOrig);

// ---------------------------------------------------------------- проигрывание перевода
let ctx = null, outGain = null, nextTime = 0, voiceUntil = 0;
const sources = new Set();
const trimmer = new PauseTrimmer(OUT_RATE);

function backlog() { return ctx ? Math.max(0, nextTime - ctx.currentTime) : 0; }

function playChunk(int16) {
  if (!ctx) return;
  let x = pcm16ToFloat(int16);
  x = trimmer.process(x, backlog() > 0.5);  // перевод отстаёт — укорачиваем паузы (голос не ускоряем)
  if (!x.length) return;
  const buf = ctx.createBuffer(1, x.length, OUT_RATE);
  buf.copyToChannel(x, 0);
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(outGain);
  const now = ctx.currentTime;
  if (nextTime < now + 0.04) nextTime = now + 0.08;  // небольшой запас против «заиканий»
  src.start(nextTime);
  let voiced = false;
  for (let i = 0; i < x.length; i += 240) if (Math.abs(x[i]) > 0.01) { voiced = true; break; }
  nextTime += buf.duration;
  if (voiced) voiceUntil = Math.max(voiceUntil, nextTime + 0.3);
  sources.add(src); src.onended = () => sources.delete(src);
}
function stopPlayback() { for (const s of sources) { try { s.stop(); } catch { /* уже */ } } sources.clear(); nextTime = 0; voiceUntil = 0; }
const translationSounding = () => ctx && ctx.currentTime < voiceUntil;

// ---------------------------------------------------------------- микрофон
let stream = null, srcNode = null, worklet = null, sink = null, resampler = null, chunker = null;
let tr = null, running = false, startedAt = 0, wakeLock = null;
let lastLoud = 0, onset = 0; const latencies = [];

async function openMic() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: !!S.noPhones,  // с наушниками эхоподавление не нужно и портит звук Bluetooth
      noiseSuppression: !!S.noise,
      autoGainControl: !!S.noise,
    },
  });
  srcNode = ctx.createMediaStreamSource(stream);
  await ctx.audioWorklet.addModule("capture-worklet.js");
  worklet = new AudioWorkletNode(ctx, "capture-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  sink = ctx.createGain(); sink.gain.value = 0;  // узел должен быть подключён к выходу, иначе браузер его не запускает
  srcNode.connect(worklet).connect(sink).connect(ctx.destination);
  resampler = new Resampler(ctx.sampleRate, IN_RATE);
  chunker = new Chunker(CHUNK_SAMPLES);
  worklet.port.onmessage = (e) => onMicData(e.data);
}

let lastLevelPaint = 0;
function onMicData(f32) {
  if (!running || !tr) return;
  const y = resampler.process(f32);
  for (let chunk of chunker.push(y)) {
    // «Без наушников»: пока звучит перевод, отправляем тишину, иначе модель услышит сама себя
    if (S.noPhones && translationSounding()) chunk = new Float32Array(chunk.length);
    const lvl = levelPercent(chunk);
    const now = performance.now();
    if (now - lastLevelPaint > 60) { document.documentElement.style.setProperty("--lvl", (lvl / 100).toFixed(2)); lastLevelPaint = now; }
    // начало фразы (после 0,6 с тишины) — для замера задержки перевода
    if (lvl > 35) {
      if (now - lastLoud > 600 && !onset && !translationSounding()) onset = now;
      lastLoud = now;
    }
    tr.pushAudio(floatToPcm16(chunk));
  }
}

function closeMic() {
  try { worklet && (worklet.port.onmessage = null, worklet.disconnect()); } catch { /* уже */ }
  try { srcNode && srcNode.disconnect(); } catch { /* уже */ }
  try { sink && sink.disconnect(); } catch { /* уже */ }
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = srcNode = worklet = sink = null;
  document.documentElement.style.setProperty("--lvl", 0);
}

// ---------------------------------------------------------------- экран не гаснет
async function lockScreen() {
  if (!S.wake || !("wakeLock" in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { /* не дали — не страшно */ }
}
document.addEventListener("visibilitychange", () => {
  // после возврата на экран снова запрещаем ему гаснуть (браузер снимает запрет при сворачивании)
  if (document.visibilityState === "visible" && running) lockScreen();
});

// ---------------------------------------------------------------- старт / стоп
function setButton(on, busy = false) {
  const b = $("btnListen");
  b.classList.toggle("on", on); b.classList.toggle("busy", busy);
  b.setAttribute("aria-label", on ? "Остановить" : "Слушать");
  $("listenLabel").textContent = busy ? "Подождите…" : on ? "Остановить" : "Слушать";
}

async function start() {
  const key = getKey();
  if (!key) { openSheet(); $("key").focus(); toast("Сначала вставьте API-ключ Gemini."); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast("Этот браузер не даёт доступ к микрофону. Откройте приложение в Chrome.", true, 7000); return; }
  setButton(true, true);
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    await ctx.resume();
    outGain = outGain || ctx.createGain(); outGain.gain.value = S.volume / 100; outGain.connect(ctx.destination);
    await openMic();
  } catch (e) {
    setButton(false); closeMic();
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    toast(denied ? "Нет доступа к микрофону. Разрешите его в настройках браузера для этого сайта." : "Не удалось включить микрофон: " + (e.message || e), true, 8000);
    return;
  }
  running = true; startedAt = Date.now(); onset = 0; latencies.length = 0; trimmer.trimmedS = 0;
  $("statLat").textContent = "—";
  setState("connecting");
  tr = new Translator({
    apiKey: key, lang: S.lang, rotateMin: S.rotateMin,
    log: (m) => console.log("[dumbrava]", m),
    events: {
      status: (s, detail) => { setState("connecting", s === "reconnecting" ? "Переподключение…" : undefined); if (detail) toast(detail); },
      connected: () => { setState("running"); setButton(true); },
      session: () => addUsage("sessions", 1),
      rotated: (reason) => console.log("[dumbrava] сессия обновлена:", reason),
      sent: (s) => addUsage("in_s", s),
      tokens: (n) => addUsage("tokens", n),
      inText: (t) => addText("in", t),
      outText: (t) => addText("out", t),
      turnEnd: () => finishLine(),
      audio: (int16) => {
        addUsage("out_s", int16.length / OUT_RATE);
        if (onset) {
          let loud = false;
          for (let i = 0; i < int16.length; i += 120) if (Math.abs(int16[i]) > 300) { loud = true; break; }
          if (loud) {
            const lat = (performance.now() - onset) / 1000; onset = 0;
            if (lat > 0.2 && lat < 15) { latencies.push(lat); if (latencies.length > 15) latencies.shift(); showLatency(); }
          }
        }
        playChunk(int16);
      },
      fatal: (msg) => { setState("error"); toast(msg, true, 9000); },
      stopped: () => { if (running) stop(true); },
    },
  });
  tr.start();
  lockScreen();
}

function showLatency() {
  const s = [...latencies].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
  $("statLat").textContent = `${med.toFixed(1).replace(".", ",")} с`;
}

function stop(fromTranslator = false) {
  running = false;
  if (tr && !fromTranslator) tr.stop();
  tr = null;
  closeMic();
  stopPlayback();
  finishLine();
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  setButton(false);
  if ($("pill").classList.contains("running") || $("pill").classList.contains("connecting")) setState("idle");
}

$("btnListen").addEventListener("click", () => {
  if ($("btnListen").classList.contains("busy")) return;
  running ? stop() : start();
});

setInterval(() => {
  if (!running) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  $("statTime").textContent = (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}, 500);

// ---------------------------------------------------------------- экран настроек
// системная кнопка «Назад» закрывает настройки, как в обычном приложении
function openSheet() {
  if ($("sheet").hidden) history.pushState({ sheet: 1 }, "");
  $("sheet").hidden = false; showUsage();
}
function closeSheet() { if (history.state && history.state.sheet) history.back(); else $("sheet").hidden = true; }
$("btnSettings").addEventListener("click", openSheet);
$("btnClose").addEventListener("click", closeSheet);
window.addEventListener("popstate", () => { $("sheet").hidden = true; });

$("key").value = getKey();
$("key").addEventListener("input", (e) => {
  localStorage.setItem(KEY_STORE, e.target.value.trim());
  $("keyCard").classList.toggle("need", !getKey());
  $("toast").hidden = true;
});
$("btnEye").addEventListener("click", () => { $("key").type = $("key").type === "password" ? "text" : "password"; });

$("vol").value = S.volume; $("volVal").textContent = S.volume + "%";
$("vol").addEventListener("input", (e) => {
  S.volume = +e.target.value; $("volVal").textContent = S.volume + "%"; saveSettings();
  if (outGain) outGain.gain.value = S.volume / 100;
});
const bindSwitch = (id, field, after) => {
  $(id).checked = !!S[field];
  $(id).addEventListener("change", (e) => { S[field] = e.target.checked; saveSettings(); after && after(); });
};
bindSwitch("optOrig", "showOrig", () => document.body.classList.toggle("hide-orig", !S.showOrig));
bindSwitch("optNoise", "noise", () => running && toast("Изменение сработает при следующем запуске."));
bindSwitch("optNoPhones", "noPhones", () => running && toast("Изменение сработает при следующем запуске."));
bindSwitch("optWake", "wake", () => { if (S.wake && running) lockScreen(); });
$("rotate").value = String(S.rotateMin);
$("rotate").addEventListener("change", (e) => { S.rotateMin = +e.target.value; saveSettings(); });

// ---------------------------------------------------------------- установка на главный экран
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("btnInstall").hidden = false; });
$("btnInstall").addEventListener("click", async () => {
  if (!installEvt) return;
  installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $("btnInstall").hidden = true;
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// первый запуск без ключа — сразу показать настройки
showUsage();
$("keyCard").classList.toggle("need", !getKey());
if (!getKey()) openSheet();  // первый запуск: сразу к ключу
window.__dumbrava = { get running() { return running; }, get backlog() { return backlog(); }, get trimmed() { return trimmer.trimmedS; } };
