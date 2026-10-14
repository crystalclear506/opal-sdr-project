// Live aircraft + ship map: runs rtl_adsb (planes, 1090 MHz) and AIS-catcher (ships, 162 MHz),
// decodes what they hear and streams it to a browser map.
//
//   npm start                                   planes (switch to ships / both on the map page)
//   npm start -- --mode both                    start with planes and ships (one dongle takes turns)
//   node server.js --lat 13.75 --lon 100.50     your location (distances + faster first fixes)
//   node server.js --log raw.txt                also save raw messages
//   node server.js --replay raw.txt             play back a saved log
//   npm run demo                                fake planes and ships, no dongle needed
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Tracker } from "./tracker.js";
import { ShipTracker } from "./ships.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const BIN = path.join(HERE, "..", "bin");

const { values: opts } = parseArgs({
  options: {
    port: { type: "string", default: "8765" },
    mode: { type: "string", default: "planes" },        // planes | ships | both (changeable on the page)
    gain: { type: "string", default: "49.6" },          // planes
    "ships-gain": { type: "string", default: "auto" },
    ppm: { type: "string", default: "0" },
    "planes-time": { type: "string", default: "40" },   // seconds per turn when sharing one dongle
    "ships-time": { type: "string", default: "40" },
    "planes-device": { type: "string", default: "0" },  // used when two dongles are plugged in
    "ships-device": { type: "string", default: "1" },
    lat: { type: "string" },
    lon: { type: "string" },
    log: { type: "string" },
    replay: { type: "string" },
    demo: { type: "boolean", default: false },
    rtl: { type: "string", default: path.join(BIN, "rtl_adsb.exe") },
    ais: { type: "string", default: path.join(BIN, "ais-catcher", "AIS-catcher.exe") },
    "no-browser": { type: "boolean", default: false },
  },
});

const MODES = ["planes", "ships", "both"];
if (!MODES.includes(opts.mode)) {
  console.error("--mode must be planes, ships or both");
  process.exit(1);
}
let mode = opts.mode;
const ref = opts.lat != null && opts.lon != null ? { lat: +opts.lat, lon: +opts.lon } : null;
const tracker = new Tracker(ref ? { refLat: ref.lat, refLon: ref.lon } : {});
const shipTracker = new ShipTracker();
const now = () => Date.now() / 1000;
const source = opts.demo ? "demo" : opts.replay ? "replay" : "radio";
const log = opts.log ? fs.createWriteStream(opts.log, { flags: "a" }) : null;
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

let status = "starting";
let sharing = null;   // { on: "planes" | "ships", until } while one dongle takes turns

function onAdsbLine(line) {
  const m = line.trim().match(/\*([0-9a-fA-F]+);/);
  if (!m) return false;
  tracker.handle(m[1].toUpperCase(), now());
  log?.write(`${now().toFixed(3)} *${m[1]};\n`);
  return true;
}

function onAisLine(line) {
  const t = line.trim();
  if (!t.startsWith("{")) return false;
  let msg;
  try { msg = JSON.parse(t); } catch { return false; }
  shipTracker.handle(msg, now());
  log?.write(`${now().toFixed(3)} AIS ${t}\n`);
  return true;
}

// ---------------------------------------------------------------- radio programs

class Receiver {
  constructor(name, exe, makeArgs, onLine) {
    Object.assign(this, { name, exe, makeArgs, onLine });
    this.status = "idle";
    this.child = null;
    this.wanted = false;
  }

  start(device) {
    this.wanted = true;
    this.device = device;
    if (this.child) return;
    if (!fs.existsSync(this.exe)) {
      this.status = `program missing: ${this.exe}`;
      return;
    }
    const child = spawn(this.exe, this.makeArgs(device), { windowsHide: true });
    this.child = child;
    this.status = "opening dongle...";
    const output = [];
    const consume = (line) => {
      if (this.onLine(line)) this.status = "receiving";
      else if (line.trim()) output.push(line.trim());
      if (/Tuned to|Sampling at|Device\s*:|Settings\s*:|Detected/i.test(line) && this.status.startsWith("opening")) {
        this.status = "listening";
      }
    };
    readline.createInterface({ input: child.stdout }).on("line", consume);
    readline.createInterface({ input: child.stderr }).on("line", consume);
    child.on("exit", () => {
      this.child = null;
      this.onExit?.();
      if (!this.wanted) return;
      const text = output.join(" ");
      this.status = /usb_open error|access denied|cannot open|busy/i.test(text)
        ? "dongle busy - close sdr.py / adsb.py / SDR++; retrying"
        : /No supported devices|no device|not found/i.test(text)
          ? "no dongle found - is it plugged in? retrying"
          : `stopped (${output.at(-1) ?? "no output"}); retrying`;
      console.log(`${this.name}: ${this.status}`);
      setTimeout(() => this.wanted && this.start(this.device), 5000);
    });
  }

  stop() {
    this.wanted = false;
    if (!this.child) return Promise.resolve();
    return new Promise((resolve) => {
      this.onExit = () => { this.onExit = null; resolve(); };
      this.child.kill();
    });
  }
}

const planes = new Receiver("planes", opts.rtl, (d) => {
  const args = ["-d", String(d), "-g", opts.gain];
  if (+opts.ppm) args.push("-p", opts.ppm);
  return args;
}, onAdsbLine);

const ships = new Receiver("ships", opts.ais, (d) => {
  const args = [`-d:${d}`, "-o", "5", "-gr", "TUNER", opts["ships-gain"]];
  if (+opts.ppm) args.push("-p", opts.ppm);
  return args;
}, onAisLine);

function countDongles() {
  return new Promise((resolve) => {
    if (!fs.existsSync(opts.ais)) return resolve(1);
    execFile(opts.ais, ["-l"], { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      const m = `${stdout}\n${stderr}`.match(/Found (\d+) device/i);
      resolve(m ? +m[1] : 1);
    });
  });
}

let dongles = null;
let generation = 0;   // bumped on every mode change; an older run notices and quits

async function startRadio() {
  const gen = ++generation;
  const current = () => gen === generation;
  sharing = null;
  await Promise.all([planes.stop(), ships.stop()]);
  if (!current()) return;
  planes.status = ships.status = "off";
  await wait(1);   // let the dongle be released
  if (!current()) return;

  if (mode === "planes") {
    status = "planes only";
    return planes.start(0);
  }
  if (mode === "ships") {
    status = "ships only";
    return ships.start(0);
  }
  dongles ??= await countDongles();
  if (!current()) return;
  if (dongles >= 2) {
    status = `${dongles} dongles: planes on #${opts["planes-device"]}, ships on #${opts["ships-device"]}`;
    planes.start(+opts["planes-device"]);
    ships.start(+opts["ships-device"]);
    return;
  }
  status = "one dongle: taking turns between planes and ships";
  while (current()) {
    for (const [rx, other, secs] of [[planes, ships, +opts["planes-time"]], [ships, planes, +opts["ships-time"]]]) {
      await other.stop();
      if (!current()) return;
      other.status = "paused - dongle is on " + rx.name;
      await wait(1);
      if (!current()) return;
      sharing = { on: rx.name, until: now() + secs };
      rx.start(0);
      await wait(secs);
      if (!current()) return;
    }
  }
}

function setMode(next) {
  if (!MODES.includes(next) || next === mode) return;
  mode = next;
  console.log(`mode: ${mode}`);
  if (source === "radio") startRadio();
}

// ---------------------------------------------------------------- replay and demo

function startReplay(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.includes("*") || l.includes(" AIS {"));
  const stamps = lines.map((l) => parseFloat(l));
  const timed = stamps.every((t) => Number.isFinite(t));
  let i = 0;
  const t0 = Date.now(), first = timed ? stamps[0] : 0;
  status = `replaying ${path.basename(file)}`;
  const feed = (line) => {
    const ais = line.indexOf(" AIS {");
    if (ais >= 0) onAisLine(line.slice(ais + 5));
    else onAdsbLine(line);
  };
  (function next() {
    while (i < lines.length && (!timed || stamps[i] - first <= (Date.now() - t0) / 1000)) {
      feed(lines[i++]);
      if (!timed && i % 20 === 0) break; // untimed logs: ~20 messages per tick
    }
    if (i < lines.length) setTimeout(next, timed ? 50 : 100);
    else status = `replay finished (${lines.length} lines)`;
  })();
}

function move(p, knots, secs) {
  const km = (knots * 1.852 * secs) / 3600;
  p.lat += (km * Math.cos((p.heading * Math.PI) / 180)) / 111.32;
  p.lon += (km * Math.sin((p.heading * Math.PI) / 180)) / (111.32 * Math.cos((p.lat * Math.PI) / 180));
}

function startDemo() {
  status = "DEMO - simulated planes and ships, not real";
  const base = ref ?? { lat: 13.75, lon: 100.6 };
  const demoPlanes = Array.from({ length: 8 }, (_, i) => ({
    icao: `DE${(0x1000 + i * 0x111).toString(16).toUpperCase()}`,
    callsign: `DEMO${i + 1}`,
    lat: base.lat + (Math.random() - 0.5) * 1.6,
    lon: base.lon + (Math.random() - 0.5) * 1.6,
    heading: Math.random() * 360,
    speed: 180 + Math.random() * 300,
    altitude: Math.round(2000 + Math.random() * 36000),
    verticalRate: 0,
    turn: (Math.random() - 0.5) * 2,
  }));
  const types = [[70, "Cargo"], [80, "Tanker"], [60, "Passenger"], [30, "Fishing"], [52, "Tug"], [70, "Cargo"]];
  const demoShips = Array.from({ length: 12 }, (_, i) => {
    const [shiptype, text] = types[i % types.length];
    const moored = i % 4 === 3;
    return {
      mmsi: 999000100 + i, shipname: `DEMO ${text.toUpperCase()} ${i + 1}`, shiptype, shiptype_text: text,
      destination: moored ? "BANGKOK" : ["LAEM CHABANG", "SINGAPORE", "BANGKOK", "SRIRACHA"][i % 4],
      to_bow: 40 + i * 12, to_stern: 10 + i * 2, to_port: 8, to_starboard: 8,
      lat: moored ? 13.70 + i * 0.002 : 12.9 + Math.random() * 0.6,
      lon: moored ? 100.565 : 100.3 + Math.random() * 0.6,
      heading: Math.random() * 360, speed: moored ? 0 : 4 + Math.random() * 12,
      status_text: moored ? "Moored" : "Under way using engine",
    };
  });
  setInterval(() => {
    for (const p of demoPlanes) {
      p.heading = (p.heading + p.turn + 360) % 360;
      move(p, p.speed, 1);
      p.verticalRate = Math.round(Math.sin(Date.now() / 20000 + p.turn * 5) * 1500 / 64) * 64;
      p.altitude = Math.max(500, p.altitude + Math.round(p.verticalRate / 60));
      if (Math.abs(p.lat - base.lat) > 1.5 || Math.abs(p.lon - base.lon) > 1.5) p.heading = (p.heading + 180) % 360;
      const { turn, ...state } = p;
      tracker.put(state, now());
    }
    for (const s of demoShips) {
      if (s.speed > 0) {
        move(s, s.speed * 20, 1);   // 20x speed so the demo visibly moves
        if (s.lat > 13.45 || s.lat < 12.6 || s.lon < 100.1 || s.lon > 100.9) s.heading = (s.heading + 180) % 360;
      }
      s.course = s.heading;
      if (Math.random() < 0.3) shipTracker.put({ type: 1, ...s, heading: Math.round(s.heading) }, now());
      if (Math.random() < 0.05) shipTracker.put({ type: 5, ...s, heading: Math.round(s.heading) }, now());
    }
  }, 1000);
}

// ---------------------------------------------------------------- web server

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };
const clients = new Set();

function receiverState(rx) {
  const left = sharing && sharing.on === rx.name ? Math.max(0, Math.round(sharing.until - now())) : null;
  return { status: rx.status, active: !!rx.child, secondsLeft: left };
}

function state() {
  const t = now();
  const s = shipTracker.snapshot(t);
  return {
    time: t, source, status, mode, receiver: ref,
    receivers: source === "radio" ? { planes: receiverState(planes), ships: receiverState(ships) } : null,
    ...tracker.snapshot(t),
    ships: s.ships, shipMessages: s.messages, shipRate: s.rate,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(state())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(state()));
  }
  if (url.pathname === "/api/mode" && req.method === "POST") {
    // JSON-only, so other websites can't trigger it from the browser (it would need a CORS preflight)
    if (!String(req.headers["content-type"]).startsWith("application/json")) {
      res.writeHead(415);
      return res.end();
    }
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 1000) req.destroy(); });
    req.on("end", () => {
      let next;
      try { next = JSON.parse(body).mode; } catch {}
      if (!MODES.includes(next)) {
        res.writeHead(400);
        return res.end("mode must be planes, ships or both");
      }
      setMode(next);
      broadcast();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ mode }));
    });
    return;
  }
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

function broadcast() {
  if (!clients.size) return;
  const data = `data: ${JSON.stringify(state())}\n\n`;
  for (const res of clients) res.write(data);
}
setInterval(broadcast, 1000);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${opts.port} is already used by another program. Try: npm start -- --port 8766`);
    shutdown();
  }
  throw err;
});

server.listen(+opts.port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${opts.port}`;
  console.log(`Map running at ${url}  (${source}${source === "radio" ? `, ${mode}` : ""}` +
    `${ref ? `, receiver at ${ref.lat}, ${ref.lon}` : ""})`);
  console.log("Ctrl+C to stop.");
  if (!opts["no-browser"]) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  if (source === "demo") startDemo();
  else if (source === "replay") startReplay(opts.replay);
  else startRadio();
});

function shutdown() {
  for (const rx of [planes, ships]) {
    rx.wanted = false;
    rx.child?.kill();
  }
  log?.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
