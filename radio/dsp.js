// Demodulators for raw RTL-SDR IQ, a port of the DSP chain in ../sdr.py so levels and squelch
// values (dB) mean the same thing in both.
//
//   const demod = new Demodulator("am");
//   const { audio, level, clipping } = demod.process(iqBytes);   // uint8 IQ at FS -> float audio at AUDIO_FS

export const FS = 1_200_000;        // IQ sample rate
export const AUDIO_FS = 48_000;     // FS / 25
export const BLOCK = 128_000;       // IQ samples per block (~107 ms)
export const IF_OFFSET = 250_000;   // tune off to the side so the dongle's DC spike isn't on the signal
export const MODES = ["wfm", "nfm", "am", "usb", "lsb"];
export const MIN_FREQ = 500e3, MAX_FREQ = 1766e6;

export function guessMode(f) {
  const mhz = f / 1e6;
  if (mhz >= 87.5 && mhz <= 108) return "wfm";
  if (mhz < 30 || (mhz > 108 && mhz < 137)) return "am";
  return "nfm";
}

export function defaultStep(mode, f) {
  if (mode === "wfm") return 100e3;
  if (mode === "usb" || mode === "lsb") return 1e3;
  if (mode === "am") return f < 30e6 ? 5e3 : 25e3;
  return 12.5e3;
}

/** '118.1M', '162.55MHz', '7200k', '101.1' (bare numbers under 3000 are MHz). Returns Hz or NaN. */
export function parseFreq(text) {
  const m = String(text).match(/^\s*([\d.]+)\s*([kmg]?)(?:hz)?\s*$/i);
  if (!m) return NaN;
  const value = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit) return value * { k: 1e3, m: 1e6, g: 1e9 }[unit];
  return value < 3000 ? value * 1e6 : value;
}

// ---------------------------------------------------------------- filter design

/** Windowed-sinc low-pass (Hamming, unity DC gain), like scipy.signal.firwin. */
export function firwin(numtaps, cutoff, fs) {
  const h = new Float32Array(numtaps);
  const fc = cutoff / fs, mid = (numtaps - 1) / 2;
  let sum = 0;
  for (let k = 0; k < numtaps; k++) {
    const t = k - mid;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    h[k] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (numtaps - 1)));
    sum += h[k];
  }
  for (let k = 0; k < numtaps; k++) h[k] /= sum;
  return h;
}

/** Second-order section (RBJ cookbook), Butterworth Q. */
class Biquad {
  constructor(type, f, fs) {
    const w = (2 * Math.PI * f) / fs, cos = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const b = type === "low" ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
    [this.b0, this.b1, this.b2] = b.map((v) => v / a0);
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.z1 = this.z2 = 0;
  }

  process(x) {
    for (let i = 0; i < x.length; i++) {
      const y = this.b0 * x[i] + this.z1;
      this.z1 = this.b1 * x[i] - this.a1 * y + this.z2;
      this.z2 = this.b2 * x[i] - this.a2 * y;
      x[i] = y;
    }
    return x;
  }
}

/** High-pass then low-pass: a band-pass for voice audio. Works in place. */
class BandPass {
  constructor(lo, hi, fs) {
    this.stages = [new Biquad("high", lo, fs), new Biquad("low", hi, fs)];
  }
  process(x) {
    for (const s of this.stages) s.process(x);
    return x;
  }
}

// ---------------------------------------------------------------- DSP blocks (all keep state between blocks)

class Mixer {
  constructor(fs, shift) {
    this.w = (2 * Math.PI * shift) / fs;
    this.phase = 0;
  }

  /** In place on separate re/im arrays. */
  process(re, im) {
    let p = this.phase;
    for (let i = 0; i < re.length; i++, p += this.w) {
      const c = Math.cos(p), s = Math.sin(p), r = re[i];
      re[i] = r * c - im[i] * s;
      im[i] = r * s + im[i] * c;
    }
    this.phase = p % (2 * Math.PI);
  }
}

/** FIR low-pass, then keep every `factor`-th sample. One instance per real channel. */
export class Decimator {
  constructor(fs, factor, cutoff, numtaps) {
    this.h = firwin(numtaps, cutoff, fs);
    this.m = factor;
    this.hist = new Float32Array(numtaps - 1);
    this.next = 0;   // index into the coming block of the next output sample
  }

  process(x) {
    const h = this.h, n = h.length, hl = n - 1, m = this.m;
    const buf = new Float32Array(hl + x.length);
    buf.set(this.hist);
    buf.set(x, hl);
    const count = this.next < x.length ? Math.floor((x.length - 1 - this.next) / m) + 1 : 0;
    const y = new Float32Array(count);
    let i = this.next;
    for (let k = 0; k < count; k++, i += m) {
      let acc = 0;
      for (let j = 0; j < n; j++) acc += h[j] * buf[i + hl - j];
      y[k] = acc;
    }
    this.next = i - x.length;
    this.hist = buf.slice(buf.length - hl);
    return y;
  }
}

class ComplexDecimator {
  constructor(...args) {
    this.re = new Decimator(...args);
    this.im = new Decimator(...args);
  }
  process(re, im) {
    return [this.re.process(re), this.im.process(im)];
  }
}

class FMDemod {
  constructor() {
    this.lr = 0;
    this.li = 0;
  }

  process(re, im) {
    const out = new Float32Array(re.length);
    let pr = this.lr, pi = this.li;
    for (let i = 0; i < re.length; i++) {
      out[i] = Math.atan2(im[i] * pr - re[i] * pi, re[i] * pr + im[i] * pi);
      pr = re[i];
      pi = im[i];
    }
    this.lr = pr;
    this.li = pi;
    return out;
  }
}

/** Keeps AM/SSB audio at a steady level: drops fast, recovers slowly. */
class AGC {
  constructor(target = 0.3, maxGain = 3e4) {
    Object.assign(this, { target, maxGain, g: 1 });
  }

  process(x) {
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    const want = Math.min(this.target / (peak + 1e-12), this.maxGain);
    if (want < this.g) {
      this.g = want;
      for (let i = 0; i < x.length; i++) x[i] *= want;
      return x;
    }
    const start = this.g, end = start + (want - start) * 0.05;
    for (let i = 0; i < x.length; i++) x[i] *= start + ((end - start) * i) / Math.max(1, x.length - 1);
    this.g = end;
    return x;
  }
}

function powerDb(re, im) {
  let sum = 0;
  for (let i = 0; i < re.length; i++) sum += re[i] * re[i] + im[i] * im[i];
  return 10 * Math.log10(sum / Math.max(1, re.length) + 1e-12);
}

function scale(x, k) {
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
}

/** uint8 IQ block at FS in -> { audio (Float32Array at AUDIO_FS), level (dB), clipping } out. */
export class Demodulator {
  constructor(mode, deemphUs = 75) {
    if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
    this.mode = mode;
    this.mix = new Mixer(FS, -IF_OFFSET);
    if (mode === "wfm") {
      this.dec1 = new ComplexDecimator(FS, 5, 110e3, 64);         // -> 240 kHz
      this.fm = new FMDemod();
      this.deemphA = Math.exp(-1 / (240e3 * deemphUs * 1e-6));
      this.deemphY = 0;
      this.dec2 = new Decimator(240e3, 5, 15e3, 64);              // -> 48 kHz audio
      return;
    }
    const halfBw = { nfm: 6e3, am: 5e3, usb: 3e3, lsb: 3e3 }[mode];
    this.dec1 = new ComplexDecimator(FS, 5, 30e3, 24);            // -> 240 kHz
    this.dec2 = new ComplexDecimator(240e3, 5, halfBw, 128);      // -> 48 kHz channel
    if (mode === "nfm") {
      this.fm = new FMDemod();
      this.post = new BandPass(300, 3500, AUDIO_FS);              // also drops CTCSS tones
    } else if (mode === "am") {
      this.post = new BandPass(60, 4500, AUDIO_FS);
      this.agc = new AGC();
    } else {
      const sign = mode === "usb" ? 1 : -1;
      this.down = new Mixer(AUDIO_FS, -sign * 1500);              // put the 150-2850 Hz sideband
      this.sideband = new ComplexDecimator(AUDIO_FS, 1, 1350, 255); // around 0 Hz, filter it,
      this.up = new Mixer(AUDIO_FS, sign * 1500);                 // and move it back
      this.agc = new AGC();
    }
  }

  process(bytes) {
    const n = bytes.length >> 1;
    const re = new Float32Array(n), im = new Float32Array(n);
    let clipped = 0;
    for (let i = 0; i < n; i++) {
      const r = bytes[2 * i];
      re[i] = r / 127.5 - 1;
      im[i] = bytes[2 * i + 1] / 127.5 - 1;
      if (r < 2 || r > 253) clipped++;
    }
    const clipping = clipped / Math.max(1, n) > 0.001;
    this.mix.process(re, im);
    let [xr, xi] = this.dec1.process(re, im);

    if (this.mode === "wfm") {
      const level = powerDb(xr, xi);
      const d = this.fm.process(xr, xi), a = this.deemphA;
      let y = this.deemphY;
      for (let i = 0; i < d.length; i++) d[i] = y = (1 - a) * d[i] + a * y;
      this.deemphY = y;
      return { audio: scale(this.dec2.process(d), 0.6), level, clipping };
    }

    [xr, xi] = this.dec2.process(xr, xi);
    const level = powerDb(xr, xi);
    let audio;
    if (this.mode === "nfm") {
      audio = scale(this.post.process(this.fm.process(xr, xi)), 1.2);
    } else if (this.mode === "am") {
      audio = new Float32Array(xr.length);
      for (let i = 0; i < xr.length; i++) audio[i] = Math.hypot(xr[i], xi[i]);
      audio = this.agc.process(this.post.process(audio));
    } else {
      this.down.process(xr, xi);
      [xr, xi] = this.sideband.process(xr, xi);
      this.up.process(xr, xi);
      audio = this.agc.process(xr);
    }
    return { audio, level, clipping };
  }
}

/** Float audio -> 16-bit little-endian PCM bytes (clipped to +-1). */
export function toPcm16(audio) {
  const out = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) {
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, audio[i])) * 32767), i * 2);
  }
  return out;
}
