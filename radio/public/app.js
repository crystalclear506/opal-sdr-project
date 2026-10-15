// Radio page: tuning controls, signal meter, favorites, and audio playback of the server's PCM stream.
const $ = (id) => document.getElementById(id);
const STEPS = [100, 1e3, 5e3, 10e3, 12.5e3, 25e3, 100e3, 1e6];
const SQ_OFF = -81;

let S = null;            // latest server state
let favs = [];
let step = null;
let lastMode = null;
let audio = null;        // { ctx, gain, abort, next } while playing
let volume = loadVolume();
const touched = {};      // control id -> time the user last moved it (don't fight their drag)

// ---------------------------------------------------------------- server

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    flash(data.error ?? `error ${res.status}`);
    return null;
  }
  return data;
}

const tune = (change) => post("/api/tune", change).then((s) => s && render(s));

const events = new EventSource("/events");
events.onmessage = (e) => render(JSON.parse(e.data));
events.addEventListener("favorites", (e) => {
  favs = JSON.parse(e.data);
  renderFavs();
});
events.onerror = () => setStatus("server not reachable – is `npm start` still running?", "bad");

// ---------------------------------------------------------------- rendering

function mhz(f) {
  return (f / 1e6).toFixed(4);
}

function stepLabel(s) {
  return s >= 1e6 ? `${s / 1e6} MHz` : `${s / 1e3} kHz`;
}

function setStatus(text, cls = "") {
  $("status").textContent = text;
  $("status").className = `status ${cls}`;
}

let flashUntil = 0;
function flash(text) {
  flashUntil = Date.now() + 4000;
  setStatus(text, "bad");
}

function recentlyTouched(id) {
  return Date.now() - (touched[id] ?? 0) < 1000;
}

function render(s) {
  const first = !S;
  S = s;
  if (first) buildControls(s);
  if (s.mode !== lastMode) {
    step = s.step;
    lastMode = s.mode;
    $("step").value = String(step);
  }

  if (Date.now() > flashUntil) {
    const listening = audio ? "" : " – press Play to listen";
    if (s.demo) setStatus(s.status, "demo");
    else if (/busy|missing|no dongle|retrying|in use/.test(s.status)) setStatus(s.status, "bad");
    else if (s.status === "receiving") setStatus("receiving" + listening, "ok");
    else setStatus(audio ? s.status : "ready" + listening);
  }

  if (document.activeElement !== $("freq")) $("freq").value = mhz(s.freq);
  for (const b of $("mode").children) b.setAttribute("aria-checked", String(b.dataset.mode === s.mode));
  if (!recentlyTouched("gain")) $("gain").value = String(s.gain);
  if (!recentlyTouched("squelch")) $("squelch").value = s.squelch ?? SQ_OFF;
  $("sq-val").textContent = s.squelch == null ? "off" : `${s.squelch} dB`;

  const pct = (db) => Math.max(0, Math.min(100, ((db + 80) / 70) * 100));
  $("meter-bar").style.width = s.level == null ? "0" : `${pct(s.level)}%`;
  $("meter-sq").style.left = s.squelch == null ? "-10px" : `calc(${pct(s.squelch)}% - 1px)`;
  $("meter").classList.toggle("muted", !!(s.muted && s.squelch != null));
  $("level").textContent = s.level == null ? "–" : `${s.level.toFixed(1)} dB`;
  $("muted").hidden = !(audio && s.muted && s.squelch != null && s.level != null);
  $("clipping").hidden = !s.clipping;

  const fav = currentFav();
  $("star").textContent = fav ? "★ Saved" : "☆ Save";
  $("star").classList.toggle("on", !!fav);
  for (const li of $("fav-list").querySelectorAll("li")) {
    li.classList.toggle("current", +li.dataset.id === fav?.id);
    li.classList.toggle("scanning", !!s.scan && +li.dataset.id === s.scan.id);
  }
  for (const box of $("fav-list").children) {
    const on = !!s.scan && s.scan.group === box.dataset.group;
    const btn = box.querySelector(".scan-btn");
    btn.textContent = on ? "■ Stop" : "Scan";
    btn.classList.toggle("on", on);
  }
  $("scan-bar").hidden = !s.scan;
  if (s.scan) {
    $("scan-bar").classList.toggle("stopped", s.scan.stopped);
    $("scan-text").textContent = s.scan.stopped
      ? `Stopped on ${s.scan.name} – active`
      : `Scanning ${s.scan.group || "Other"} (${s.scan.count} channels)… ${s.scan.name}`;
  }
}

function buildControls(s) {
  for (const m of s.modes) {
    const b = document.createElement("button");
    b.textContent = m.toUpperCase();
    b.dataset.mode = m;
    b.setAttribute("role", "radio");
    b.title = { wfm: "Wide FM – broadcast radio", nfm: "Narrow FM – walkie-talkies, marine, ham",
      am: "AM – airband (ATC), shortwave", usb: "Upper sideband – ham above 10 MHz", lsb: "Lower sideband – ham below 10 MHz" }[m];
    b.onclick = () => tune({ mode: m });
    $("mode").append(b);
  }
  $("gain").append(new Option("auto", "auto"));
  for (const g of s.gains) $("gain").append(new Option(`${g} dB`, String(g)));
  for (const st of STEPS) $("step").append(new Option(stepLabel(st), String(st)));
}

function currentFav() {
  return S && favs.find((f) => f.freq === S.freq && f.mode === S.mode);
}

function renderFavs() {
  const list = $("fav-list");
  list.replaceChildren();
  const groups = [...new Set(favs.map((f) => f.group))];
  $("group-list").replaceChildren(...groups.filter(Boolean).map((g) => new Option(g)));
  for (const g of groups) {
    const box = el("div", "fav-group", "");
    box.dataset.group = g;
    const head = el("div", "group-head", "");
    const title = el("h3", "", g || "Other");
    const count = favs.filter((f) => f.group === g).length;
    title.append(el("span", "count", ` · ${count}`));
    const scanBtn = el("button", "scan-btn", "Scan");
    scanBtn.title = count > 1 ? `Hop through ${g || "these"} channels and stop on any that are active` : "Listen to this channel";
    scanBtn.onclick = () => toggleScan(g);
    head.append(title, scanBtn);
    box.append(head, el("ul", "", ""));
    list.append(box);
  }
  favs.forEach((f, i) => {
    const li = document.createElement("li");
    li.dataset.id = f.id;
    li.title = `Tune to ${f.name}`;
    const num = el("span", "num", i < 9 ? String(i + 1) : "");
    const name = el("span", "name", f.name);
    const meta = el("span", "meta", `${(f.freq / 1e6).toFixed(3)} ${f.mode.toUpperCase()}${f.squelch != null ? ` · sq ${f.squelch}` : ""}`);
    const del = el("button", "del", "✕");
    del.title = `Remove ${f.name}`;
    del.onclick = (e) => {
      e.stopPropagation();
      post("/api/favorites/delete", { id: f.id });
    };
    li.append(num, name, meta, del);
    li.onclick = () => goFav(f);
    [...list.children].find((b) => b.dataset.group === f.group).querySelector("ul").append(li);
  });
  $("fav-empty").hidden = favs.length > 0;
  if (S) render(S);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

function toggleScan(group) {
  if (S?.scan?.group === group) return post("/api/scan", { stop: true }).then((s) => s && render(s));
  if (!audio) play();
  post("/api/scan", { group }).then((s) => s && render(s));
}

function goFav(f) {
  tune({ freq: f.freq, mode: f.mode, squelch: f.squelch ?? "off" });
}

// ---------------------------------------------------------------- audio

async function play() {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const gain = ctx.createGain();
  gain.gain.value = volume;
  gain.connect(ctx.destination);
  const abort = new AbortController();
  const a = (audio = { ctx, gain, abort, next: 0 });
  $("play").textContent = "■ Stop";
  $("play").classList.add("on");
  if (S) render(S);
  try {
    const res = await fetch("/audio", { signal: abort.signal });
    const rate = +res.headers.get("X-Sample-Rate") || 48000;
    const reader = res.body.getReader();
    let carry = null;   // odd byte left over from the previous chunk
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let bytes = value;
      if (carry) {
        bytes = new Uint8Array(value.length + 1);
        bytes[0] = carry[0];
        bytes.set(value, 1);
        carry = null;
      }
      if (bytes.length % 2) {
        carry = bytes.slice(-1);
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (bytes.length) schedule(a, bytes, rate);
    }
  } catch (err) {
    if (err.name !== "AbortError") flash(`audio stopped: ${err.message}`);
  }
  if (audio === a) stop();
}

function schedule(a, bytes, rate) {
  const n = bytes.length / 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const buf = a.ctx.createBuffer(1, n, rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
  const now = a.ctx.currentTime;
  if (a.next < now + 0.05) a.next = now + 0.3;   // starting or ran dry: build a small cushion
  if (a.next > now + 1.5) return;                // too far behind real time: drop this bit
  const src = a.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(a.gain);
  src.start(a.next);
  a.next += buf.duration;
}

function stop() {
  if (!audio) return;
  audio.abort.abort();
  audio.ctx.close();
  audio = null;
  $("play").textContent = "▶ Play";
  $("play").classList.remove("on");
  if (S) render(S);
}

function loadVolume() {
  try {
    const v = parseFloat(localStorage.getItem("radio-volume"));
    return Number.isFinite(v) ? v : 1;
  } catch {
    return 1;
  }
}

function setVolume(v) {
  volume = Math.max(0, Math.min(3, v));
  $("volume").value = Math.round(volume * 100);
  $("vol-val").textContent = `${Math.round(volume * 100)}%`;
  if (audio) audio.gain.gain.setTargetAtTime(volume, audio.ctx.currentTime, 0.02);
  try { localStorage.setItem("radio-volume", String(volume)); } catch {}
}

// ---------------------------------------------------------------- controls

function tuneBy(dir) {
  if (!S) return;
  const f = Math.round(S.freq / step) * step + dir * step;
  tune({ freq: f });
}

function changeStep(dir) {
  const i = STEPS.reduce((best, s, j) => (Math.abs(s - step) < Math.abs(STEPS[best] - step) ? j : best), 0);
  step = STEPS[Math.max(0, Math.min(STEPS.length - 1, i + dir))];
  $("step").value = String(step);
}

function changeGain(dir) {
  if (!S) return;
  const gains = S.gains;
  const cur = S.gain === "auto" ? gains[0] : S.gain;
  const i = gains.reduce((best, g, j) => (Math.abs(g - cur) < Math.abs(gains[best] - cur) ? j : best), 0);
  tune({ gain: gains[Math.max(0, Math.min(gains.length - 1, i + dir))] });
}

function changeSquelch(dir) {
  if (!S) return;
  if (S.squelch == null) {
    if (dir > 0) tune({ squelch: S.level == null ? -60 : Math.round(S.level) });
    return;
  }
  const next = S.squelch + 2 * dir;
  tune({ squelch: next <= -80 ? "off" : next });
}

function nextMode() {
  if (!S) return;
  tune({ mode: S.modes[(S.modes.indexOf(S.mode) + 1) % S.modes.length] });
}

function openSave() {
  if (!S) return;
  const fav = currentFav();
  $("fav-name").value = fav?.name ?? "";
  $("fav-group").value = fav?.group ?? (S.scan?.group || "");
  $("fav-form").hidden = false;
  $("fav-name").focus();
  $("fav-name").select();
}

$("play").onclick = () => (audio ? stop() : play());
$("up").onclick = () => tuneBy(1);
$("down").onclick = () => tuneBy(-1);
$("step").onchange = () => (step = +$("step").value);
$("star").onclick = openSave;
$("sq-auto").onclick = () => tune({ squelch: "auto" });
$("gain").onchange = () => {
  touched.gain = Date.now();
  const v = $("gain").value;
  tune({ gain: v === "auto" ? "auto" : +v });
};
$("squelch").oninput = () => {
  touched.squelch = Date.now();
  const v = +$("squelch").value;
  $("sq-val").textContent = v <= SQ_OFF ? "off" : `${v} dB`;
  tune({ squelch: v <= SQ_OFF ? "off" : v });
};
$("volume").oninput = () => setVolume(+$("volume").value / 100);
setVolume(volume);

$("freq").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    tune({ freq: $("freq").value.trim(), mode: "auto" }).then(() => $("freq").blur());
  } else if (e.key === "Escape") {
    $("freq").blur();
  }
});
$("freq").addEventListener("focus", () => $("freq").select());
$("freq").addEventListener("blur", () => S && ($("freq").value = mhz(S.freq)));

$("fav-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const saved = await post("/api/favorites", { name: $("fav-name").value, group: $("fav-group").value, freq: S.freq, mode: S.mode, squelch: S.squelch });
  if (saved) $("fav-form").hidden = true;
});
$("fav-cancel").onclick = () => ($("fav-form").hidden = true);
for (const id of ["fav-name", "fav-group"]) {
  $(id).addEventListener("keydown", (e) => e.key === "Escape" && ($("fav-form").hidden = true));
}
$("scan-skip").onclick = () => post("/api/scan", { skip: true });
$("scan-stop").onclick = () => post("/api/scan", { stop: true }).then((s) => s && render(s));

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement && t.type !== "range") return;
  if (t instanceof HTMLSelectElement) return;
  if (t instanceof HTMLButtonElement && (e.key === " " || e.key === "Enter")) return;   // let the button click
  const keys = {
    " ": () => (audio ? stop() : play()),
    ArrowRight: () => tuneBy(1),
    ArrowLeft: () => tuneBy(-1),
    ArrowUp: () => changeStep(1),
    ArrowDown: () => changeStep(-1),
    m: nextMode,
    a: () => tune({ squelch: "auto" }),
    s: () => changeSquelch(-1),
    S: () => changeSquelch(1),
    g: () => changeGain(-1),
    G: () => changeGain(1),
    "-": () => setVolume(volume / 1.25),
    "+": () => setVolume(volume * 1.25),
    "=": () => setVolume(volume * 1.25),
    f: () => $("freq").focus(),
    "*": openSave,
    n: () => S?.scan && post("/api/scan", { skip: true }),
    Escape: () => S?.scan && post("/api/scan", { stop: true }).then((s) => s && render(s)),
  };
  let action = keys[e.key];
  if (!action && /^[1-9]$/.test(e.key) && favs[+e.key - 1]) action = () => goFav(favs[+e.key - 1]);
  if (!action) return;
  e.preventDefault();
  action();
});
