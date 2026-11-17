// Dumbrava Translate (телефон) — ядро без привязки к странице.
// Звук → Gemini 3.5 Live Translate по WebSocket → перевод.
// Логика перенесена из версии для ПК (live_translate.py), где она отлажена:
// куски по 40 мс, плавное обновление сессии, переподключение, откаты.

export const MODEL = "models/gemini-3.5-live-translate-preview";
export const IN_RATE = 16000;   // Gemini принимает PCM16 моно 16 кГц
export const OUT_RATE = 24000;  // и отдаёт PCM16 24 кГц
export const SEND_MS = 40;      // куски по 40 мс: первый звук перевода приходит быстрее, чем при 100 мс
export const CHUNK_SAMPLES = IN_RATE * SEND_MS / 1000;  // 640
export const CONNECT_TIMEOUT_MS = 15000;
export const ROTATE_OVERLAP_MS = 6000;  // столько старая сессия договаривает после переключения
export const MAX_QUEUE_CHUNKS = 5000 / SEND_MS;  // не держим больше 5 с звука в очереди
export const API_VERSIONS = ["v1beta", "v1alpha"];  // в «v1» Live API нет

export function wsUrl(apiKey, version = "v1beta") {
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${version}` +
    `.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
}

export function buildSetup(lang, { echo = false, compress = true } = {}) {
  const setup = {
    model: MODEL,
    generationConfig: {
      responseModalities: ["AUDIO"],
      translationConfig: { targetLanguageCode: lang, echoTargetLanguage: !!echo },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  if (compress) {
    // Сжатие контекста (рекомендация Google для длинных сессий).
    setup.contextWindowCompression = { triggerTokens: 32000, slidingWindow: { targetTokens: 8000 } };
  }
  return { setup };
}

// ---------------------------------------------------------------- звук

/** Потоковый ресемплер: ФНЧ (windowed-sinc, 63 отсчёта) + линейная интерполяция.
 *  Хранит состояние между кусками — на стыках нет щелчков. */
export class Resampler {
  constructor(srcRate, dstRate, taps = 63) {
    this.src = srcRate; this.dst = dstRate; this.ratio = srcRate / dstRate;
    this.pass = srcRate === dstRate;
    this.h = null;
    if (srcRate > dstRate) {
      const cutoff = 0.45 * dstRate, h = new Float32Array(taps);
      let sum = 0;
      for (let i = 0; i < taps; i++) {
        const n = i - (taps - 1) / 2;
        const x = 2 * cutoff / srcRate * n;
        const sinc = n === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const win = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
        h[i] = sinc * win; sum += h[i];
      }
      for (let i = 0; i < taps; i++) h[i] /= sum;
      this.h = h; this.tail = new Float32Array(taps - 1);
    }
    this.buf = new Float32Array(0); this.pos = 0;
  }
  process(x) {
    if (this.pass || x.length === 0) return x;
    if (this.h) {
      const T = this.h.length, ext = new Float32Array(this.tail.length + x.length);
      ext.set(this.tail); ext.set(x, this.tail.length);
      const y = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) {
        let acc = 0;
        for (let k = 0; k < T; k++) acc += ext[i + k] * this.h[T - 1 - k];
        y[i] = acc;
      }
      this.tail = ext.slice(ext.length - (T - 1));
      x = y;
    }
    const buf = new Float32Array(this.buf.length + x.length);
    buf.set(this.buf); buf.set(x, this.buf.length);
    const last = buf.length - 1;
    if (last < this.pos) { this.buf = buf; return new Float32Array(0); }
    const nOut = Math.floor((last - this.pos) / this.ratio) + 1;
    const out = new Float32Array(nOut);
    for (let i = 0; i < nOut; i++) {
      const p = this.pos + i * this.ratio, i0 = Math.floor(p), f = p - i0;
      out[i] = i0 + 1 <= last ? buf[i0] * (1 - f) + buf[i0 + 1] * f : buf[i0];
    }
    const next = this.pos + nOut * this.ratio;
    const drop = Math.min(Math.floor(next), last);
    this.buf = buf.slice(drop); this.pos = next - drop;
    return out;
  }
}

/** Режет поток на куски фиксированной длины. */
export class Chunker {
  constructor(size) { this.size = size; this.buf = new Float32Array(0); }
  push(x) {
    const buf = new Float32Array(this.buf.length + x.length);
    buf.set(this.buf); buf.set(x, this.buf.length);
    const out = [];
    let i = 0;
    for (; i + this.size <= buf.length; i += this.size) out.push(buf.slice(i, i + this.size));
    this.buf = buf.slice(i);
    return out;
  }
}

export function floatToPcm16(x) {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

export function pcm16ToFloat(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

export function bytesToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** PCM16 (little-endian байты) → Int16Array без копирования, если выровнено. */
export function bytesToInt16(u8) {
  if (u8.byteOffset % 2 === 0 && u8.byteLength % 2 === 0) return new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength / 2);
  const c = u8.slice(0, u8.byteLength - (u8.byteLength % 2));
  return new Int16Array(c.buffer);
}

export function levelPercent(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const rms = x.length ? Math.sqrt(s / x.length) : 0;
  const db = 20 * Math.log10(rms + 1e-9);
  return Math.max(0, Math.min(100, (db + 60) / 60 * 100));
}

/** Укорачивает паузы длиннее keepMs (кадры по 10 мс тише thrDb). Речь не трогается —
 *  перевод догоняет, а голос не ускоряется. Состояние run переносится между кусками. */
export class PauseTrimmer {
  constructor(rate = OUT_RATE, keepMs = 80, thrDb = -45) {
    this.frame = rate / 100; this.keep = Math.max(1, Math.round(keepMs / 10));
    this.thr = Math.pow(10, thrDb / 20); this.run = 0; this.trimmedS = 0; this.rate = rate;
  }
  /** x: Float32Array; active: включено ли вырезание (перевод отстаёт). */
  process(x, active) {
    const f = this.frame, n = Math.floor(x.length / f);
    if (!active || n === 0) { this.run = 0; return x; }
    const keep = [];
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = i * f; j < (i + 1) * f; j++) s += x[j] * x[j];
      const quiet = Math.sqrt(s / f) < this.thr;
      if (quiet) { this.run++; if (this.run <= this.keep) keep.push(i); }
      else { this.run = 0; keep.push(i); }
    }
    if (keep.length === n) return x;
    const out = new Float32Array(keep.length * f + (x.length - n * f));
    keep.forEach((fi, k) => out.set(x.subarray(fi * f, (fi + 1) * f), k * f));
    out.set(x.subarray(n * f), keep.length * f);
    this.trimmedS += (x.length - out.length) / this.rate;
    return out;
  }
}

// ---------------------------------------------------------------- ошибки

const FATAL = [
  [["api key not valid", "api_key_invalid", "invalid api key"], "Неверный API-ключ. Проверьте ключ в Google AI Studio."],
  [["permission_denied", "permission denied"], "Нет доступа к модели перевода для этого ключа."],
  [["resource_exhausted", "quota"], "Исчерпана квота Google. Подождите минуту или проверьте лимиты в AI Studio."],
  [["not found", "is not supported", "not_found"], "Модель перевода недоступна для этого ключа (или изменилось её название)."],
];

/** Возвращает {message, fatal} по коду и причине закрытия WebSocket. */
export function describeClose(code, reason) {
  const low = String(reason || "").toLowerCase();
  for (const [needles, msg] of FATAL) {
    if (needles.some(n => low.includes(n))) return { message: msg, fatal: true, detail: reason };
  }
  if (code === 1007 || code === 1008) {
    return { message: "Сервер отклонил настройки сессии.", fatal: true, detail: reason, config: true };
  }
  if (code === 1006 && !reason) return { message: "Нет связи с сервером Gemini.", fatal: false, detail: "" };
  return { message: `Связь прервалась (код ${code}).`, fatal: false, detail: reason };
}

// ---------------------------------------------------------------- сессии

/** Одно соединение с Gemini Live. */
export class Conn {
  constructor({ WebSocketImpl, apiKey, version, setup, onMessage, onClose, log }) {
    this.openedAt = 0; this.ready = false; this.closed = false;
    this.onMessage = onMessage; this.onClose = onClose; this.log = log || (() => {});
    this.ws = new WebSocketImpl(wsUrl(apiKey, version));
    this.ws.binaryType = "arraybuffer";
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.ready) { reject({ code: 4000, reason: "timeout", message: "Сервер Gemini не ответил за 15 с.", fatal: false }); this.close(); }
      }, CONNECT_TIMEOUT_MS);
      this.ws.onopen = () => { this.ws.send(JSON.stringify(setup)); };
      this.ws.onmessage = async (ev) => {
        let text = ev.data;
        if (typeof text !== "string") {
          if (text instanceof ArrayBuffer) text = new TextDecoder().decode(text);
          else if (text && typeof text.text === "function") text = await text.text();
          else text = String(text);
        }
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (!this.ready && msg.setupComplete !== undefined) {
          this.ready = true; this.openedAt = Date.now(); clearTimeout(timer); resolve(this);
          return;
        }
        this.onMessage(this, msg);
      };
      this.ws.onclose = (ev) => {
        clearTimeout(timer);
        this.closed = true;
        const info = { code: ev.code, reason: ev.reason || "" };
        if (!this.ready) reject({ ...info, ...describeClose(ev.code, ev.reason) });
        else this.onClose(this, info);
      };
      this.ws.onerror = () => { /* за ним всегда следует onclose */ };
    });
  }
  sendAudio(b64) {
    if (this.closed || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: `audio/pcm;rate=${IN_RATE}` } } }));
    return true;
  }
  sendAudioEnd() {
    if (!this.closed && this.ws.readyState === 1) this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }
  close() {
    this.closed = true;
    try { this.ws.close(1000, "bye"); } catch { /* уже закрыто */ }
  }
}

/** Держит перевод живым: подключение, плавное обновление (make-before-break) каждые
 *  rotateMin минут и по сигналу goAway, переподключение при сбоях, откаты. */
export class Translator {
  constructor({ apiKey, lang, echo = false, rotateMin = 8, WebSocketImpl = globalThis.WebSocket, events = {}, log }) {
    Object.assign(this, { apiKey, lang, echo, rotateMs: rotateMin > 0 ? rotateMin * 60000 : 0, WebSocketImpl });
    this.ev = events; this.log = log || (() => {});
    this.active = null; this.queue = []; this.running = false;
    this.compress = true; this.versionIdx = 0; this.everConnected = false; this.failures = 0;
    this.rotations = 0; this.rotateTimer = null; this.retryTimer = null; this.lastTotal = new WeakMap();
  }

  emit(name, ...a) { const f = this.ev[name]; if (f) f(...a); }

  start() { this.running = true; this._connect(); }

  stop() {
    this.running = false;
    clearTimeout(this.rotateTimer); clearTimeout(this.retryTimer);
    if (this.active) { this.active.close(); this.active = null; }
    this.queue = [];
    this.emit("stopped");
  }

  /** Кусок звука PCM16 16 кГц (Int16Array, 640 отсчётов). */
  pushAudio(int16) {
    const b64 = bytesToB64(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength));
    if (this.active && this.active.ready && !this.active.closed && this.queue.length === 0) {
      if (this.active.sendAudio(b64)) { this.emit("sent", int16.length / IN_RATE); return; }
    }
    this.queue.push(b64);
    if (this.queue.length > MAX_QUEUE_CHUNKS) this.queue.shift();  // связь тормозит — старое выбрасываем
    this._flush();
  }

  _flush() {
    const c = this.active;
    if (!c || !c.ready || c.closed) return;
    while (this.queue.length) {
      if (!c.sendAudio(this.queue[0])) return;
      this.queue.shift();
      this.emit("sent", CHUNK_SAMPLES / IN_RATE);
    }
  }

  _setup() { return buildSetup(this.lang, { echo: this.echo, compress: this.compress }); }

  _open() {
    const conn = new Conn({
      WebSocketImpl: this.WebSocketImpl, apiKey: this.apiKey, version: API_VERSIONS[this.versionIdx],
      setup: this._setup(), log: this.log,
      onMessage: (c, m) => this._onMessage(c, m),
      onClose: (c, info) => this._onClose(c, info),
    });
    return conn.readyPromise;
  }

  async _connect() {
    if (!this.running) return;
    this.emit("status", "connecting");
    try {
      const conn = await this._open();
      if (!this.running) { conn.close(); return; }
      this.active = conn; this.everConnected = true;
      this.emit("connected");
      this.emit("session");
      this._flush();
      this._scheduleRotation();
    } catch (err) {
      this._handleFailure(err);
    }
  }

  _handleFailure(err) {
    if (!this.running) return;
    const e = err && err.message ? err : { ...describeClose(err?.code, err?.reason), ...err };
    // сервер не принял сжатие контекста для этой модели — работаем без него
    if (!this.everConnected && this.compress && e.config) {
      this.compress = false; this.log("сжатие контекста не принято, продолжаю без него");
      return this._connect();
    }
    // соединение не открылось вообще — пробуем другую версию API
    if (!this.everConnected && e.code === 1006 && this.versionIdx + 1 < API_VERSIONS.length && this.failures >= 1) {
      this.versionIdx++; this.log("пробую " + API_VERSIONS[this.versionIdx]);
    }
    this.failures++;
    if (e.fatal && !e.config || (e.config && !this.compress) || (!this.everConnected && this.failures >= 3) || this.failures >= 6) {
      this.emit("fatal", e.message, e.detail || "");
      this.stop();
      return;
    }
    const delay = Math.min(10, 2 ** (this.failures - 1));
    this.emit("status", "reconnecting", `${e.message} Повтор через ${delay} с…`);
    this.retryTimer = setTimeout(() => this._connect(), delay * 1000);
  }

  _scheduleRotation(ms) {
    clearTimeout(this.rotateTimer);
    if (!this.rotateMs && ms === undefined) return;
    this.rotateTimer = setTimeout(() => this._rotate("плановое обновление"), ms ?? this.rotateMs);
  }

  /** Плавное обновление: открыть новую сессию, переключить звук, старой дать договорить. */
  async _rotate(reason) {
    if (!this.running || this._rotating) return;
    this._rotating = true;
    try {
      const fresh = await this._open();
      if (!this.running) { fresh.close(); return; }
      const old = this.active;
      this.active = fresh; this.failures = 0; this.rotations++;
      this._flush();
      if (old) { old.retired = true; setTimeout(() => old.close(), ROTATE_OVERLAP_MS); }
      this.emit("rotated", reason, this.rotations);
      this.emit("session");
      this._scheduleRotation();
    } catch (err) {
      this.log("не удалось обновить сессию: " + (err.message || err.reason));
      this._scheduleRotation(30000);  // старая ещё работает — попробуем через 30 с
    } finally {
      this._rotating = false;
    }
  }

  _onClose(conn, info) {
    if (conn.retired || conn !== this.active || !this.running) return;
    this.active = null;
    clearTimeout(this.rotateTimer);
    if (Date.now() - conn.openedAt > 10000) this.failures = 0;  // сессия успела поработать
    this._handleFailure({ ...describeClose(info.code, info.reason), code: info.code, reason: info.reason });
  }

  _onMessage(conn, msg) {
    if (msg.goAway) {
      this.log("goAway: " + JSON.stringify(msg.goAway));
      if (conn === this.active) this._rotate("сервер попросил");
      return;
    }
    if (msg.usageMetadata && typeof msg.usageMetadata.totalTokenCount === "number") {
      const prev = this.lastTotal.get(conn) || 0, total = msg.usageMetadata.totalTokenCount;
      const delta = total >= prev ? total - prev : total;
      this.lastTotal.set(conn, total);
      if (delta > 0) this.emit("tokens", delta);
    }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.inputTranscription && sc.inputTranscription.text) this.emit("inText", sc.inputTranscription.text);
    if (sc.outputTranscription && sc.outputTranscription.text) this.emit("outText", sc.outputTranscription.text);
    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (parts) {
      for (const p of parts) {
        const d = p.inlineData;
        if (d && d.data) this.emit("audio", bytesToInt16(b64ToBytes(d.data)), d.mimeType || "");
      }
    }
    if (sc.turnComplete) this.emit("turnEnd");
  }
}

// ---------------------------------------------------------------- языки (как на ПК)

export const LANGUAGES = [
  ["ru", "Русский"], ["uk", "Украинский"], ["en", "Английский"], ["ro", "Румынский"], ["de", "Немецкий"],
  ["fr", "Французский"], ["es", "Испанский"], ["it", "Итальянский"], ["pl", "Польский"],
  ["pt-BR", "Португальский (Бразилия)"], ["pt-PT", "Португальский (Португалия)"], ["tr", "Турецкий"],
  ["zh-Hans", "Китайский (упрощённый)"], ["zh-Hant", "Китайский (традиционный)"], ["ja", "Японский"],
  ["ko", "Корейский"], ["ar", "Арабский"], ["he", "Иврит"], ["hi", "Хинди"], ["be", "Белорусский"],
  ["kk", "Казахский"], ["uz", "Узбекский"], ["az", "Азербайджанский"], ["hy", "Армянский"], ["ka", "Грузинский"],
  ["bg", "Болгарский"], ["cs", "Чешский"], ["sk", "Словацкий"], ["sr", "Сербский"], ["hr", "Хорватский"],
  ["sl", "Словенский"], ["mk", "Македонский"], ["hu", "Венгерский"], ["el", "Греческий"], ["nl", "Нидерландский"],
  ["da", "Датский"], ["sv", "Шведский"], ["no", "Норвежский"], ["fi", "Финский"], ["et", "Эстонский"],
  ["lv", "Латышский"], ["lt", "Литовский"], ["is", "Исландский"], ["ca", "Каталанский"], ["gl", "Галисийский"],
  ["eu", "Баскский"], ["sq", "Албанский"], ["fa", "Персидский"], ["ur", "Урду"], ["bn", "Бенгальский"],
  ["pa", "Панджаби"], ["gu", "Гуджарати"], ["mr", "Маратхи"], ["ta", "Тамильский"], ["te", "Телугу"],
  ["kn", "Каннада"], ["ml", "Малаялам"], ["si", "Сингальский"], ["ne", "Непальский"], ["sd", "Синдхи"],
  ["th", "Тайский"], ["vi", "Вьетнамский"], ["id", "Индонезийский"], ["ms", "Малайский"], ["fil", "Филиппинский"],
  ["jv", "Яванский"], ["su", "Сунданский"], ["km", "Кхмерский"], ["lo", "Лаосский"], ["my", "Бирманский"],
  ["mn", "Монгольский"], ["sw", "Суахили"], ["am", "Амхарский"], ["ha", "Хауса"], ["zu", "Зулу"],
  ["af", "Африкаанс"], ["rw", "Киньяруанда"], ["ak", "Акан"],
];
