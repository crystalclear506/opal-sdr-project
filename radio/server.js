// Radio in the browser: runs rtl_tcp, demodulates WFM / NFM / AM / USB / LSB here in Node and
// streams the audio to a web page with tuning controls, a signal meter, squelch and favorites.
//
//   npm start                                   open the page (tunes to 121.1 MHz AM)
//   node server.js --freq 101.1M                start on another frequency
//   node server.js --gain 30 --ppm 2            tuner gain and frequency correction
//   npm run demo                                simulated stations, no dongle needed
//
//
// Favorites can be put in groups (ATC, First responders, ...) and a group can be scanned: the radio
// hops through its channels and stops on whichever one is active.
//
// The dongle is only opened while a page is playing, so you can close the tab and start the map.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AUDIO_FS, BLOCK, Demodulator, FS, IF_OFFSET, MAX_FREQ, MIN_FREQ, MODES,
  defaultStep, guessMode, parseFreq, toPcm16 } from "./dsp.js";
import { Favorites } from "./favorites.js";
import { Scanner } from "./scanner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const BIN = path.join(HERE, "..", "bin");

const { values: opts } = parseArgs({
  options: {
    port: { type: "string", default: "8766" },
    freq: { type: "string", default: "121.1M" },
    mode: { type: "string" },                            // default: guessed from the frequency
    gain: { type: "string", default: "40" },             // dB or auto
    squelch: { type: "string" },                         // dB, e.g. -45
    ppm: { type: "string", default: "0" },
    device: { type: "string", default: "0" },
    deemph: { type: "string", default: "50" },           // WFM de-emphasis: 50 us (Thailand, Europe) or 75 (Americas)
    "tcp-port": { type: "string", default: "1234" },
    rtl: { type: "string", default: path.join(BIN, "rtl_tcp.exe") },
    favorites: { type: "string", default: path.join(HERE, "favorites.json") },
    demo: { type: "boolean", default: false },
    "no-browser": { type: "boolean", default: false },
  },
});

// R828D / R820T gain steps in dB
const GAINS = [0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4,
  28, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48, 49.6];

/** Nearest gain step the tuner really has, or "auto". */
function snapGain(g) {
  if (g === "auto") return g;
  return GAINS.reduce((best, x) => (Math.abs(x - g) < Math.abs(best - g) ? x : best));
}

const radio = {
  freq: parseFreq(opts.freq),
  mode: null,
  gain: opts.gain === "auto" ? "auto" : snapGain(+opts.gain),
  squelch: opts.squelch != null ? +opts.squelch : null,
  level: null,
  noise: null,
  muted: false,
  clipping: false,
  status: "idle - press Play",
};
if (!(radio.freq >= MIN_FREQ && radio.freq <= MAX_FREQ)) {
  console.error(`--freq must be between 0.5 and 1766 MHz`);
  process.exit(1);
}
radio.mode = opts.mode ?? guessMode(radio.freq);
if (!MODES.includes(radio.mode)) {
  console.error(`--mode must be one of ${MODES.join(", ")}`);
  process.exit(1);
}
let demod = new Demodulator(radio.mode, +opts.deemph);
const favorites = new Favorites(opts.favorites);
const audioClients = new Set();
const eventClients = new Set();

// ---------------------------------------------------------------- audio processing

const HANG_BLOCKS = 4;   // keep the squelch open ~0.4 s after the signal drops, so words aren't clipped
let hang = 0;
let scanner = null;

function send(pcm) {
  for (const res of audioClients) {
    if (res.writableLength < 1 << 20) res.write(pcm);   // skip a client that isn't keeping up
  }
}

function onBlock(bytes) {
  const { audio, level, clipping } = demod.process(bytes);
  const scan = scanner?.block(level, radio.squelch ?? -45);
  if (scan?.settling) return send(Buffer.alloc(audio.length * 2));   // still the old frequency
  radio.level = level;
  radio.noise = radio.noise == null ? level : 0.9 * radio.noise + 0.1 * level;
  radio.clipping = clipping;
  if (radio.squelch == null || level >= radio.squelch) hang = HANG_BLOCKS;
  else if (hang > 0) hang--;
  radio.muted = hang === 0;
  send(toPcm16(radio.muted ? new Float32Array(audio.length) : audio));
  if (scan?.hop) setChannel(scanner.next());
}

// ---------------------------------------------------------------- dongle via rtl_tcp

class RtlTcp {
  constructor() {
    this.child = null;
    this.sock = null;
    this.wanted = false;
  }

  start() {
    this.wanted = true;
    if (this.child) return;
    if (!fs.existsSync(opts.rtl)) {
      radio.status = `program missing: ${opts.rtl}`;
      return;
    }
    const args = ["-a", "127.0.0.1", "-p", opts["tcp-port"], "-d", opts.device, "-s", String(FS),
      "-f", String(Math.round(radio.freq - IF_OFFSET)), "-g", radio.gain === "auto" ? "0" : String(radio.gain)];
    if (+opts.ppm) args.push("-P", opts.ppm);
    const child = spawn(opts.rtl, args, { windowsHide: true });
    this.child = child;
    radio.status = "opening dongle...";
    const output = [];
    const onLine = (line) => line.trim() && output.push(line.trim());
    readline.createInterface({ input: child.stdout }).on("line", onLine);
    readline.createInterface({ input: child.stderr }).on("line", onLine);
    child.on("error", (err) => output.push(err.message));
    // rtl_tcp's "listening..." can sit in a pipe buffer, so just keep trying to connect
    setTimeout(() => this.connect(child), 500);
    child.on("exit", () => {
      this.child = null;
      this.sock?.destroy();
      this.sock = null;
      if (!this.wanted) return;
      const text = output.join(" ");
      radio.status = /usb_claim_interface|usb_open error|access denied|busy/i.test(text)
        ? "dongle busy - close the map, sdr.py, adsb.py or SDR++; retrying"
        : /No supported devices|no device|not found/i.test(text)
          ? "no dongle found - is it plugged in? retrying"
          : /bind|address already in use/i.test(text)
            ? `port ${opts["tcp-port"]} in use - try --tcp-port 1235; retrying`
            : `stopped (${output.at(-1) ?? "no output"}); retrying`;
      console.log(`radio: ${radio.status}`);
      setTimeout(() => this.wanted && this.start(), 3000);
    });
  }

  connect(child) {
    if (this.child !== child || !this.wanted) return;
    const sock = net.connect(+opts["tcp-port"], "127.0.0.1");
    this.sock = sock;
    let header = 12;                  // "RTL0" + tuner type + gain count
    const block = Buffer.alloc(BLOCK * 2);
    let fill = 0;
    sock.on("connect", () => {
      radio.status = "receiving";
      this.sendGain();
    });
    sock.on("data", (data) => {
      let i = 0;
      if (header > 0) {
        i = Math.min(header, data.length);
        header -= i;
      }
      while (i < data.length) {
        const n = data.copy(block, fill, i);
        fill += n;
        i += n;
        if (fill === block.length) {
          onBlock(block);
          fill = 0;
        }
      }
    });
    sock.on("error", () => {
      if (this.sock !== sock) return;
      this.sock = null;
      if (header === 12) setTimeout(() => this.connect(child), 500);   // not up yet
    });
    sock.on("close", () => {
      if (this.sock === sock && header === 0) this.child?.kill();   // lost the stream: restart rtl_tcp
    });
  }

  command(cmd, value) {
    if (!this.sock || this.sock.connecting) return;
    const b = Buffer.alloc(5);
    b.writeUInt8(cmd, 0);
    b.writeUInt32BE(value >>> 0, 1);
    this.sock.write(b);
  }

  setFreq() {
    this.command(0x01, Math.round(radio.freq - IF_OFFSET));
  }

  sendGain() {
    if (radio.gain === "auto") return this.command(0x03, 0);
    this.command(0x03, 1);
    this.command(0x04, Math.round(radio.gain * 10));
  }

  stop() {
    this.wanted = false;
    this.sock?.destroy();
    this.sock = null;
    this.child?.kill();
    radio.status = "idle - press Play";
    radio.level = radio.noise = null;
  }
}

// ---------------------------------------------------------------- demo: simulated stations

class DemoSource {
  constructor() {
    this.timer = null;
    this.t = 0;
    this.stations = [
      { freq: 121.1e6, kind: "am", tone: 600, on: 3, period: 7 },
      { freq: 122.35e6, kind: "am", tone: 900, on: 2, period: 11 },
      { freq: 101.1e6, kind: "fm", tone: 440, dev: 75e3 },
      { freq: 145.5e6, kind: "fm", tone: 700, dev: 3e3, on: 4, period: 9 },
    ];
  }

  start() {
    if (this.timer) return;
    radio.status = "DEMO - simulated stations, not real";
    this.timer = setInterval(() => onBlock(this.block()), (BLOCK / FS) * 1000);
  }

  block() {
    const bytes = Buffer.alloc(BLOCK * 2);
    const re = new Float32Array(BLOCK), im = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      re[i] = (Math.random() + Math.random() + Math.random() - 1.5) * 0.02;
      im[i] = (Math.random() + Math.random() + Math.random() - 1.5) * 0.02;
    }
    const center = radio.freq - IF_OFFSET;
    for (const s of this.stations) {
      const off = s.freq - center;
      if (Math.abs(off) > FS / 2 || (s.period && this.t % s.period > s.on)) continue;
      for (let i = 0; i < BLOCK; i++) {
        const t = this.t + i / FS;
        let phase = 2 * Math.PI * off * t, amp = 0.3;
        if (s.kind === "am") amp *= 1 + 0.6 * Math.sin(2 * Math.PI * s.tone * t);
        else phase += (s.dev / s.tone) * Math.sin(2 * Math.PI * s.tone * t);
        re[i] += amp * Math.cos(phase);
        im[i] += amp * Math.sin(phase);
      }
    }
    for (let i = 0; i < BLOCK; i++) {
      bytes[2 * i] = Math.max(0, Math.min(255, Math.round((re[i] + 1) * 127.5)));
      bytes[2 * i + 1] = Math.max(0, Math.min(255, Math.round((im[i] + 1) * 127.5)));
    }
    this.t += BLOCK / FS;
    return bytes;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    radio.status = "idle - press Play";
    radio.level = radio.noise = null;
  }

  setFreq() {}
  sendGain() {}
}

const source = opts.demo ? new DemoSource() : new RtlTcp();
let stopTimer = null;

function listenerJoined() {
  clearTimeout(stopTimer);
  source.start();
}

function listenerLeft() {
  if (audioClients.size) return;
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => !audioClients.size && source.stop(), 3000);   // release the dongle
}

// ---------------------------------------------------------------- tuning

/** Applies a change from the page. Returns an error message, or null. */
function tune(req) {
  let { freq, mode, gain, squelch } = req;
  if (freq != null) {
    freq = typeof freq === "number" ? freq : parseFreq(freq);
    if (!(freq >= MIN_FREQ && freq <= MAX_FREQ)) return "frequency must be between 0.5 and 1766 MHz";
  }
  if (mode === "auto") mode = guessMode(freq ?? radio.freq);
  if (mode != null && !MODES.includes(mode)) return `mode must be one of ${MODES.join(", ")}`;
  if (gain != null && gain !== "auto" && !(Number.isFinite(gain) && gain >= 0 && gain <= 50)) return "gain must be 0-50 dB or auto";
  if (squelch != null && squelch !== "auto" && squelch !== "off" && !Number.isFinite(squelch)) return "bad squelch";

  if (freq != null || mode != null) scanner = null;   // tuning by hand ends a scan
  setChannel({ freq, mode });
  if (gain != null) gain = snapGain(gain);
  if (gain != null && gain !== radio.gain) {
    radio.gain = gain;
    source.sendGain();
  }
  if (squelch === "off") radio.squelch = null;
  else if (squelch === "auto") radio.squelch = radio.noise == null ? -45 : Math.round(radio.noise + 4);
  else if (squelch != null) radio.squelch = Math.round(squelch);
  return null;
}

/** Moves to a frequency and/or mode (and the channel's own squelch, if it has one). */
function setChannel({ freq, mode, squelch }) {
  if (freq != null && freq !== radio.freq) {
    radio.freq = freq;
    source.setFreq();
    radio.noise = null;   // new channel: re-learn its noise floor
  }
  if (mode != null && mode !== radio.mode) {
    radio.mode = mode;
    demod = new Demodulator(mode, +opts.deemph);
    radio.noise = null;
  }
  if (Number.isFinite(squelch)) radio.squelch = squelch;
}

/** Starts scanning a favorites group, or { stop: true } / { skip: true }. Returns an error message, or null. */
function scan(req) {
  if (req.stop) {
    scanner = null;
    return null;
  }
  if (req.skip) {
    if (scanner) setChannel(scanner.next());
    return null;
  }
  const group = String(req.group ?? "");
  try {
    scanner = new Scanner(group, favorites.inGroup(group));
  } catch (err) {
    return err.message;
  }
  if (radio.squelch == null) radio.squelch = -45;   // scanning needs a squelch to know what's active
  setChannel(scanner.next());
  return null;
}

function state() {
  return {
    ...radio,
    demo: opts.demo,
    playing: !!(source.child || source.timer),
    step: defaultStep(radio.mode, radio.freq),
    gains: GAINS,
    modes: MODES,
    listeners: audioClients.size,
    scan: scanner && { group: scanner.group, id: scanner.current.id, name: scanner.current.name,
      count: scanner.channels.length, stopped: scanner.stopped },
  };
}

// ---------------------------------------------------------------- web server

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };

function sendEvent(res, name, data) {
  res.write(`${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(name, data) {
  for (const res of eventClients) sendEvent(res, name, data);
}

function readJson(req, res, handle) {
  // JSON-only, so other websites can't trigger it from the browser (it would need a CORS preflight)
  if (!String(req.headers["content-type"]).startsWith("application/json")) {
    res.writeHead(415);
    return res.end();
  }
  let body = "";
  req.on("data", (d) => { body += d; if (body.length > 10000) req.destroy(); });
  req.on("end", () => {
    let data;
    try { data = JSON.parse(body); } catch {}
    if (data == null || typeof data !== "object") {
      res.writeHead(400);
      return res.end("expected a JSON object");
    }
    handle(data);
  });
}

function reply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/audio") {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-cache",
      "X-Sample-Rate": String(AUDIO_FS) });
    res.flushHeaders();
    audioClients.add(res);
    listenerJoined();
    req.on("close", () => {
      audioClients.delete(res);
      listenerLeft();
    });
    return;
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    sendEvent(res, null, state());
    sendEvent(res, "favorites", favorites.list);
    eventClients.add(res);
    req.on("close", () => eventClients.delete(res));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/tune") {
    return readJson(req, res, (data) => {
      const err = tune(data);
      if (err) return reply(res, 400, { error: err });
      broadcast(null, state());
      reply(res, 200, state());
    });
  }
  if (req.method === "POST" && url.pathname === "/api/scan") {
    return readJson(req, res, (data) => {
      const err = scan(data);
      if (err) return reply(res, 400, { error: err });
      broadcast(null, state());
      reply(res, 200, state());
    });
  }
  if (req.method === "POST" && url.pathname === "/api/favorites") {
    return readJson(req, res, (data) => {
      try {
        const fav = favorites.save(data);
        broadcast("favorites", favorites.list);
        reply(res, 200, fav);
      } catch (err) {
        reply(res, 400, { error: err.message });
      }
    });
  }
  if (req.method === "POST" && url.pathname === "/api/favorites/delete") {
    return readJson(req, res, (data) => {
      if (!favorites.remove(data.id)) return reply(res, 404, { error: "no such favorite" });
      broadcast("favorites", favorites.list);
      reply(res, 200, { ok: true });
    });
  }
  if (url.pathname === "/api/favorites") return reply(res, 200, favorites.list);

  const file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
});

setInterval(() => eventClients.size && broadcast(null, state()), 200);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${opts.port} is already used by another program. Try: npm start -- --port 8767`);
    shutdown();
  }
  throw err;
});

server.listen(+opts.port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${opts.port}`;
  console.log(`Radio running at ${url}  (${opts.demo ? "demo" : "radio"}, ${(radio.freq / 1e6).toFixed(4)} MHz ${radio.mode.toUpperCase()})`);
  console.log("Ctrl+C to stop.");
  if (!opts["no-browser"]) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
});

function shutdown() {
  source.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
