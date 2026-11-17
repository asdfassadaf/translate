// Забирает звук микрофона в отдельном звуковом потоке браузера и
// пересылает его в основную страницу порциями примерно по 20 мс.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.len = 0;
    this.target = Math.round(sampleRate / 50); // ~20 мс
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.parts.push(new Float32Array(ch));
      this.len += ch.length;
      if (this.len >= this.target) {
        const out = new Float32Array(this.len);
        let o = 0;
        for (const p of this.parts) { out.set(p, o); o += p.length; }
        this.port.postMessage(out, [out.buffer]);
        this.parts = [];
        this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
