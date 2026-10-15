import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIO_FS, BLOCK, Decimator, Demodulator, FS, IF_OFFSET, firwin, guessMode, parseFreq } from "../dsp.js";

/** uint8 IQ for a carrier `off` Hz above the tuned frequency, optionally AM or FM modulated by a tone. */
function iq(n, { off = 0, amp = 0.3, am = 0, fmDev = 0, tone = 1000, t0 = 0, noise = 0 } = {}) {
  const bytes = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / FS;
    let phase = 2 * Math.PI * (IF_OFFSET + off) * t;
    if (fmDev) phase += (fmDev / tone) * Math.sin(2 * Math.PI * tone * t);
    const a = amp * (1 + am * Math.sin(2 * Math.PI * tone * t));
    bytes[2 * i] = Math.max(0, Math.min(255, Math.round((a * Math.cos(phase) + noise * (Math.random() - 0.5) + 1) * 127.5)));
    bytes[2 * i + 1] = Math.max(0, Math.min(255, Math.round((a * Math.sin(phase) + noise * (Math.random() - 0.5) + 1) * 127.5)));
  }
  return bytes;
}

/** Strength of one frequency in a signal (single-bin DFT), 0..~0.5 for a unit sine. */
function toneLevel(x, f, fs) {
  let re = 0, im = 0;
  for (let i = 0; i < x.length; i++) {
    re += x[i] * Math.cos((2 * Math.PI * f * i) / fs);
    im += x[i] * Math.sin((2 * Math.PI * f * i) / fs);
  }
  return Math.hypot(re, im) / x.length;
}

/** Share of a signal's energy that is in one tone: ~1 for a pure tone, ~0 if it's absent. */
function toneShare(x, f, fs) {
  const rms = Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
  return (toneLevel(x, f, fs) * 2) / Math.SQRT2 / (rms + 1e-12);
}

function run(mode, opts, blocks = 4) {
  const d = new Demodulator(mode);
  let out;
  for (let b = 0; b < blocks; b++) out = d.process(iq(BLOCK, { ...opts, t0: (b * BLOCK) / FS }));
  return out;
}

test("parseFreq understands units and bare MHz", () => {
  assert.equal(parseFreq("118.1M"), 118.1e6);
  assert.equal(parseFreq("162.55MHz"), 162.55e6);
  assert.equal(parseFreq("7200k"), 7.2e6);
  assert.equal(parseFreq("121.1"), 121.1e6);
  assert.equal(parseFreq(121100000), 121.1e6);
  assert.ok(Number.isNaN(parseFreq("abc")));
});

test("guessMode picks AM for airband, WFM for broadcast", () => {
  assert.equal(guessMode(121.1e6), "am");
  assert.equal(guessMode(101.1e6), "wfm");
  assert.equal(guessMode(145.5e6), "nfm");
  assert.equal(guessMode(7.2e6), "am");
});

test("firwin has unity gain at DC", () => {
  const h = firwin(64, 15e3, 240e3);
  assert.ok(Math.abs(h.reduce((a, b) => a + b, 0) - 1) < 1e-5);
});

test("decimator gives the same output whether fed at once or in odd pieces", () => {
  const x = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) + (i % 13) / 13);
  const whole = new Decimator(FS, 5, 30e3, 24).process(x);
  const d = new Decimator(FS, 5, 30e3, 24);
  const parts = [];
  for (const [a, b] of [[0, 3], [3, 101], [101, 500], [500, 1000]]) parts.push(...d.process(x.subarray(a, b)));
  assert.equal(parts.length, whole.length);
  parts.forEach((v, i) => assert.ok(Math.abs(v - whole[i]) < 1e-5));
});

test("AM demod recovers the tone; a carrier reads much stronger than empty air", () => {
  const { audio, level } = run("am", { am: 0.5, tone: 1000 });
  assert.equal(audio.length, BLOCK / 25);
  assert.ok(toneLevel(audio, 1000, AUDIO_FS) > 0.05, "1 kHz tone present");
  assert.ok(toneLevel(audio, 2500, AUDIO_FS) < 0.01, "little else");
  const empty = run("am", { amp: 0 }).level;
  assert.ok(level > empty + 30, `signal ${level} vs empty ${empty}`);
});

test("AM rejects a station 25 kHz away", () => {
  const on = run("am", { am: 0.5 }).level;
  const off = run("am", { am: 0.5, off: 25e3 }).level;
  assert.ok(on - off > 20, `on ${on} off ${off}`);
});

test("NFM and WFM demod recover the tone", () => {
  for (const [mode, fmDev] of [["nfm", 3e3], ["wfm", 50e3]]) {
    const { audio } = run(mode, { fmDev, tone: 1000 });
    assert.ok(toneLevel(audio, 1000, AUDIO_FS) > 0.05, `${mode} tone`);
  }
});

test("USB hears a carrier just above the dial as a tone, LSB doesn't", () => {
  const usb = run("usb", { off: 1000, noise: 0.3 }).audio;
  const lsb = run("lsb", { off: 1000, noise: 0.3 }).audio;
  assert.ok(toneShare(usb, 1000, AUDIO_FS) > 0.9, `usb ${toneShare(usb, 1000, AUDIO_FS)}`);
  assert.ok(toneShare(lsb, 1000, AUDIO_FS) < 0.3, `lsb ${toneShare(lsb, 1000, AUDIO_FS)}`);
});

test("clipping is flagged when the IQ hits the rails", () => {
  assert.equal(run("am", { amp: 0.3 }, 1).clipping, false);
  assert.equal(run("am", { amp: 1.2 }, 1).clipping, true);
});
