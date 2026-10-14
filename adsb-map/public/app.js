// Live map: satellite basemap with aircraft (ADS-B) and ships (AIS) at their decoded lat/lon.
// The map data uses Web Mercator pixel coordinates at zoom 12 ("world" units below).

const WORLD = 256 * 2 ** 12;
const THAILAND = { x0: 807844, y0: 463432, x1: 832019, y1: 507863 };
const BANGKOK = { x: 817200, y: 483900 };
const BANGKOK_DETAIL_SCALE = 0.2;   // show city roads/canals when zoomed in past this
const LABEL_SCALE = 0.045;          // show province names when zoomed in past this
const STALE_POSITION = 30;          // seconds, aircraft
const STALE_SHIP = 600;             // seconds, ships report less often
const SHIP_LABEL_SCALE = 0.15;      // show ship names when zoomed in past this

const $ = (id) => document.getElementById(id);
const svg = $("map"), world = $("world"), overlay = $("overlay");

const view = { cx: BANGKOK.x, cy: BANGKOK.y, s: 0.12 };
let autoFit = true;          // until the user pans/zooms, keep everything in view
let lastFitCount = -1;
let selected = null;         // "plane:ICAO" or "ship:MMSI"
let latest = null;
let provinceLabels = [], waterLabels = [];

function project(lat, lon) {
  const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * WORLD, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * WORLD];
}

function size() {
  return { W: svg.clientWidth, H: svg.clientHeight };
}

function toScreen(x, y) {
  const { W, H } = size();
  return [W / 2 + (x - view.cx) * view.s, H / 2 + (y - view.cy) * view.s];
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- colours

const ALT_STOPS = [
  [0, [255, 140, 66]],
  [10000, [255, 209, 102]],
  [20000, [110, 231, 160]],
  [30000, [92, 200, 255]],
  [40000, [180, 140, 255]],
];

function altColor(alt) {
  if (alt == null) return "#9aa7b8";
  const a = Math.max(0, Math.min(40000, alt));
  for (let i = 1; i < ALT_STOPS.length; i++) {
    const [h1, c1] = ALT_STOPS[i];
    if (a <= h1) {
      const [h0, c0] = ALT_STOPS[i - 1];
      const t = (a - h0) / (h1 - h0);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * t)).join(",")})`;
    }
  }
  return "rgb(180,140,255)";
}

const SHIP_COLORS = {
  cargo: ["#4ade80", "Cargo"], tanker: ["#f87171", "Tanker"], passenger: ["#60a5fa", "Passenger"],
  fishing: ["#fb923c", "Fishing"], tug: ["#22d3ee", "Tug / port"], highspeed: ["#facc15", "High speed"],
  special: ["#e879f9", "Pilot / SAR / law"], pleasure: ["#f9a8d4", "Pleasure / sail"],
  aid: ["#a78bfa", "Navigation aid"], station: ["#e2e8f0", "Base station"], other: ["#cbd5e1", "Other / unknown"],
};
const shipColor = (s) => (SHIP_COLORS[s.category] ?? SHIP_COLORS.other)[0];

$("ship-legend").innerHTML = Object.values(SHIP_COLORS).slice(0, 8)
  .map(([c, name]) => `<span><span class="swatch" style="background:${c}"></span>${name}</span>`).join("");

// What the dongle listens to; the server owns this, the page mirrors it.
const layers = { planes: true, ships: false };
let mode = "planes";
let modeRequest = null;      // mode we've asked the server for and are waiting on

function applyMode(next) {
  mode = next;
  layers.planes = next !== "ships";
  layers.ships = next !== "planes";
  document.body.dataset.mode = next;
  for (const b of document.querySelectorAll("#mode button")) b.setAttribute("aria-checked", b.dataset.mode === next);
}
applyMode(mode);

$("legend-bar").style.background =
  `linear-gradient(to right, ${ALT_STOPS.map(([h, c]) => `rgb(${c}) ${(h / 40000) * 100}%`).join(", ")})`;

// ---------------------------------------------------------------- basemap

async function loadMap() {
  const [thai, bkk] = await Promise.all([
    fetch("maps/easternThailandVector.json").then((r) => r.json()),
    fetch("maps/bangkokRoadsAndWater.json").then((r) => r.json()),
  ]);
  $("land").innerHTML = thai.provinces.map((p) => `<path d="${p.d}"><title>${esc(p.name)}</title></path>`).join("");
  $("rivers").innerHTML = `<path d="${thai.rivers}"/>`;
  $("highways").innerHTML = thai.highways.map((h) => `<path d="${h.d}"><title>${esc(h.name)}</title></path>`).join("");
  $("bangkok").innerHTML = [
    `<path class="water" d="${bkk.riverPolygons}"/>`,
    `<path class="water" d="${bkk.lakePolygons}"/>`,
    `<path class="canal" d="${bkk.majorCanals}"/>`,
    `<path class="road" d="${bkk.primaryRoads}"/>`,
    `<path class="expressway" d="${bkk.expressways}"/>`,
  ].join("");
  provinceLabels = thai.provinces.map((p) => ({ name: p.name, x: p.labelPos[0], y: p.labelPos[1] }));
  waterLabels = thai.waterLabels.map((w) => ({ name: w.name, x: w.labelPos[0], y: w.labelPos[1] }));
  render();
}

// ---------------------------------------------------------------- satellite tiles (same source as SatMap)

const TILE_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const tilesGroup = $("tiles");
const tileLayers = new Map();   // zoom level -> { g, imgs: Map(key -> <image>) }
let tileZ = null, tileCleanup = null;

let basemap = "satellite";
try { basemap = localStorage.getItem("basemap") ?? "satellite"; } catch {}

// Both options use the satellite imagery; "dark" dims it.
function setBasemap(name) {
  basemap = name === "dark" ? "dark" : "satellite";
  document.body.classList.add("satellite");
  document.body.classList.toggle("dim", basemap === "dark");
  $("basemap").textContent = basemap === "dark" ? "Bright map" : "Dark map";
  try { localStorage.setItem("basemap", basemap); } catch {}
  render();
}

function updateTiles() {
  const { W, H } = size();
  const z = Math.min(18, Math.max(3, Math.round(12 + Math.log2(view.s * (window.devicePixelRatio || 1)))));
  const span = 256 * 2 ** (12 - z);          // one tile, in world units
  const n = 2 ** z;
  const tx0 = Math.max(0, Math.floor((view.cx - W / 2 / view.s) / span));
  const tx1 = Math.min(n - 1, Math.floor((view.cx + W / 2 / view.s) / span));
  const ty0 = Math.max(0, Math.floor((view.cy - H / 2 / view.s) / span));
  const ty1 = Math.min(n - 1, Math.floor((view.cy + H / 2 / view.s) / span));
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 600) return;

  let layer = tileLayers.get(z);
  if (!layer) {
    layer = { g: document.createElementNS("http://www.w3.org/2000/svg", "g"), imgs: new Map() };
    tileLayers.set(z, layer);
  }
  tilesGroup.appendChild(layer.g);           // current level on top; older levels show through while loading
  if (z !== tileZ) {
    tileZ = z;
    clearTimeout(tileCleanup);
    tileCleanup = setTimeout(() => {
      for (const [lz, l] of tileLayers) if (lz !== tileZ) { l.g.remove(); tileLayers.delete(lz); }
    }, 1500);
  }

  const wanted = new Set();
  const overlap = span / 256;                // one image pixel, hides hairline seams
  for (let x = tx0; x <= tx1; x++) {
    for (let y = ty0; y <= ty1; y++) {
      const key = `${x}/${y}`;
      wanted.add(key);
      if (layer.imgs.has(key)) continue;
      const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
      img.setAttribute("href", TILE_URL(z, x, y));
      img.setAttribute("x", x * span);
      img.setAttribute("y", y * span);
      img.setAttribute("width", span + overlap);
      img.setAttribute("height", span + overlap);
      img.setAttribute("preserveAspectRatio", "none");
      layer.g.appendChild(img);
      layer.imgs.set(key, img);
    }
  }
  for (const [key, img] of layer.imgs) {
    if (!wanted.has(key)) { img.remove(); layer.imgs.delete(key); }
  }
}

// ---------------------------------------------------------------- drawing

const SHIP = "M0,-9 L4,-3 L4,7 L-4,7 L-4,-3 Z";
const PLANE =
  "M0,-11 L1.8,-4 L10,1.5 L10,3.5 L1.8,1.5 L1.3,7.5 L4.5,9.8 L4.5,11 L0,10 L-4.5,11 L-4.5,9.8 L-1.3,7.5 L-1.8,1.5 L-10,3.5 L-10,1.5 L-1.8,-4 Z";

function fmtAlt(alt) {
  if (alt == null) return "";
  return alt >= 10000 ? `FL${Math.round(alt / 100)}` : `${alt.toLocaleString()} ft`;
}

const trailPoints = (trail) =>
  trail.map(([lat, lon]) => toScreen(...project(lat, lon)).map((v) => v.toFixed(1)).join(",")).join(" ");

function render() {
  const { W, H } = size();
  world.setAttribute("transform", `translate(${W / 2 - view.cx * view.s} ${H / 2 - view.cy * view.s}) scale(${view.s})`);
  $("bangkok").style.display = view.s >= BANGKOK_DETAIL_SCALE ? "" : "none";
  updateTiles();

  const out = [];
  const onScreen = ([x, y], m = 40) => x > -m && y > -m && x < W + m && y < H + m;

  for (const l of waterLabels) {
    const p = toScreen(l.x, l.y);
    if (onScreen(p)) out.push(`<text class="water-label" x="${p[0]}" y="${p[1]}">${esc(l.name)}</text>`);
  }
  if (view.s >= LABEL_SCALE) {
    for (const l of provinceLabels) {
      const p = toScreen(l.x, l.y);
      if (onScreen(p)) out.push(`<text class="place-label" x="${p[0]}" y="${p[1]}">${esc(l.name)}</text>`);
    }
  }

  if (latest?.receiver) {
    const [x, y] = toScreen(...project(latest.receiver.lat, latest.receiver.lon));
    const metersPerWorldPx = (156543.03 / 4096) * Math.cos((latest.receiver.lat * Math.PI) / 180);
    const ringPx = (100000 / metersPerWorldPx) * view.s;   // 100 km range ring
    out.push(`<g class="receiver"><circle class="ring" cx="${x}" cy="${y}" r="${ringPx}"/>` +
      `<circle cx="${x}" cy="${y}" r="5"/><text x="${x + 9}" y="${y + 4}">you</text></g>`);
  }

  // ships first, so planes draw on top
  const shipList = layers.ships ? (latest?.ships ?? []).filter((s) => s.lat != null) : [];
  for (const s of shipList) {
    if (s.trail.length > 1) out.push(`<polyline class="ship-trail" points="${trailPoints(s.trail)}" stroke="${shipColor(s)}"/>`);
  }
  for (const s of shipList) {
    const [x, y] = toScreen(...project(s.lat, s.lon));
    if (!onScreen([x, y], 40)) continue;
    const key = `ship:${s.mmsi}`;
    const cls = ["ship", s.posAgo > STALE_SHIP && "stale", key === selected && "selected"].filter(Boolean).join(" ");
    const dir = s.heading ?? s.course;
    const c = shipColor(s);
    const shape = s.category === "station" ? `<rect x="-4" y="-4" width="8" height="8" fill="${c}"/>`
      : s.category === "aid" ? `<path d="M0,-6 L6,0 L0,6 L-6,0 Z" fill="${c}"/>`
      : dir != null && (s.speed ?? 0) >= 0.5 ? `<path d="${SHIP}" fill="${c}" transform="rotate(${dir})"/>`
      : `<circle class="body" r="4.5" fill="${c}"/>`;
    out.push(`<g class="${cls}" data-key="${key}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
      `<circle r="12" fill="transparent"/>${shape}</g>`);
    if (view.s >= SHIP_LABEL_SCALE || key === selected) {
      out.push(`<text class="ship-label" x="${x + 9}" y="${y - 2}">${esc(s.name || s.mmsi)}` +
        `<tspan class="sub" x="${x + 9}" dy="12">${s.speed != null ? `${s.speed} kn` : ""}</tspan></text>`);
    }
  }

  const planes = layers.planes ? (latest?.aircraft ?? []).filter((a) => a.lat != null) : [];
  for (const a of planes) {
    if (a.trail.length > 1) out.push(`<polyline class="trail" points="${trailPoints(a.trail)}" stroke="${altColor(a.altitude)}"/>`);
  }
  for (const a of planes) {
    const [x, y] = toScreen(...project(a.lat, a.lon));
    if (!onScreen([x, y], 80)) continue;
    const key = `plane:${a.icao}`;
    const cls = ["plane", a.posAgo > STALE_POSITION && "stale", key === selected && "selected"].filter(Boolean).join(" ");
    const shape = a.heading == null
      ? `<circle r="6" fill="${altColor(a.altitude)}"/>`
      : `<path d="${PLANE}" fill="${altColor(a.altitude)}" transform="rotate(${a.heading})"/>`;
    out.push(`<g class="${cls}" data-key="${key}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
      `<circle r="16" fill="transparent"/>${shape}</g>`);
    out.push(`<text class="plane-label" x="${x + 14}" y="${y - 4}">${esc(a.callsign || a.icao)}` +
      `<tspan class="sub" x="${x + 14}" dy="13">${fmtAlt(a.altitude)}${a.speed != null ? ` · ${a.speed} kt` : ""}</tspan></text>`);
  }
  overlay.innerHTML = out.join("");
}

// ---------------------------------------------------------------- view control

function fitBox(x0, y0, x1, y1, minWorld = 1500) {
  const { W, H } = size();
  const w = Math.max(x1 - x0, minWorld), h = Math.max(y1 - y0, minWorld);
  view.cx = (x0 + x1) / 2;
  view.cy = (y0 + y1) / 2;
  view.s = Math.min(W / w, H / h) * 0.85;
}

function positioned() {
  return [
    ...(layers.planes ? latest?.aircraft ?? [] : []),
    ...(layers.ships ? latest?.ships ?? [] : []),
  ].filter((o) => o.lat != null);
}

function fitAll() {
  const pts = positioned().map((o) => project(o.lat, o.lon));
  if (latest?.receiver) pts.push(project(latest.receiver.lat, latest.receiver.lon));
  if (!pts.length) return false;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  fitBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
  return true;
}

function zoomAt(factor, mx, my) {
  const { W, H } = size();
  const wx = view.cx + (mx - W / 2) / view.s, wy = view.cy + (my - H / 2) / view.s;
  view.s = Math.min(8, Math.max(0.004, view.s * factor));
  view.cx = wx - (mx - W / 2) / view.s;
  view.cy = wy - (my - H / 2) / view.s;
  autoFit = false;
  render();
}

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = svg.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

let drag = null;
svg.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false };
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 4) {
    drag.moved = true;
    svg.classList.add("dragging");
  }
  if (drag.moved) {
    view.cx = drag.cx - dx / view.s;
    view.cy = drag.cy - dy / view.s;
    autoFit = false;
    render();
  }
});
svg.addEventListener("pointerup", (e) => {
  const wasClick = drag && !drag.moved;
  drag = null;
  svg.classList.remove("dragging");
  if (!wasClick) return;
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".plane, .ship");
  select(target ? target.dataset.key : null, false);
});
svg.addEventListener("dblclick", (e) => {
  const r = svg.getBoundingClientRect();
  zoomAt(2, e.clientX - r.left, e.clientY - r.top);
});

$("zoom-in").onclick = () => zoomAt(1.6, size().W / 2, size().H / 2);
$("zoom-out").onclick = () => zoomAt(1 / 1.6, size().W / 2, size().H / 2);
$("fit").onclick = () => {
  autoFit = true;
  if (fitAll()) render();
};
$("thailand").onclick = () => {
  autoFit = false;
  fitBox(THAILAND.x0, THAILAND.y0, THAILAND.x1, THAILAND.y1);
  render();
};
window.addEventListener("resize", render);
for (const btn of document.querySelectorAll("#mode button")) {
  btn.onclick = async () => {
    const next = btn.dataset.mode;
    if (next === mode) return;
    const prev = mode;
    modeRequest = next;
    applyMode(next);
    lastFitCount = -1;
    render();
    renderPanel();
    try {
      const r = await fetch("api/mode", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }),
      });
      if (!r.ok) throw new Error(await r.text());
    } catch {
      applyMode(prev);
      render();
      renderPanel();
    } finally {
      modeRequest = null;
    }
  };
}
$("basemap").onclick = () => setBasemap(basemap === "satellite" ? "dark" : "satellite");

// ---------------------------------------------------------------- side panel

function findSelected() {
  if (!selected || !latest) return null;
  const [kind, id] = selected.split(":");
  if (!layers[kind === "plane" ? "planes" : "ships"]) return null;
  const item = kind === "plane"
    ? latest.aircraft.find((a) => a.icao === id)
    : latest.ships.find((s) => String(s.mmsi) === id);
  return item ? { kind, item } : null;
}

function select(key, center = true) {
  selected = key;
  const found = findSelected();
  if (center && found?.item.lat != null) {
    [view.cx, view.cy] = project(found.item.lat, found.item.lon);
    view.s = Math.max(view.s, found.kind === "ship" ? 0.3 : 0.08);
    autoFit = false;
  }
  render();
  renderPanel();
}

const row = (k, v) => `<dt>${k}</dt><dd>${v ?? "-"}</dd>`;
const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;

function planeDetails(a) {
  const vr = a.verticalRate == null ? "-" : `${a.verticalRate > 0 ? "▲" : a.verticalRate < 0 ? "▼" : ""} ${Math.abs(a.verticalRate)} ft/min`;
  return `<h2>${esc(a.callsign || "no call sign")} <small>ICAO ${a.icao}</small></h2><dl>` +
    row("Altitude", a.altitude == null ? null : `${a.altitude.toLocaleString()} ft`) +
    row("Climb", vr) +
    row("Speed", a.speed == null ? null : `${a.speed} kt (${Math.round(a.speed * 1.852)} km/h)`) +
    row("Heading", a.heading == null ? null : `${a.heading}°`) +
    row("Position", a.lat == null ? "waiting for an even/odd pair" : `${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}`) +
    (a.distanceKm != null ? row("Distance", `${a.distanceKm} km`) : "") +
    row("Messages", a.msgs) +
    row("Last heard", `${a.seenAgo}s ago`) +
    `</dl>` +
    link(`https://globe.adsbexchange.com/?icao=${a.icao.toLowerCase()}`, "ADS-B Exchange") +
    (a.callsign ? link(`https://www.flightradar24.com/${encodeURIComponent(a.callsign)}`, "Flightradar24") : "");
}

function ago(secs) {
  return secs < 90 ? `${secs}s ago` : `${Math.round(secs / 60)} min ago`;
}

function shipDetails(s) {
  return `<h2>${esc(s.name || "name not received yet")} <small>MMSI ${s.mmsi}</small></h2><dl>` +
    row("Type", esc(s.shiptypeText ?? (SHIP_COLORS[s.category] ?? SHIP_COLORS.other)[1])) +
    row("Status", s.status && esc(s.status)) +
    row("Speed", s.speed == null ? null : `${s.speed} kn (${(s.speed * 1.852).toFixed(1)} km/h)`) +
    row("Course", s.course == null ? null : `${Math.round(s.course)}°`) +
    row("Heading", s.heading == null ? null : `${s.heading}°`) +
    row("Destination", s.destination && esc(s.destination)) +
    row("Size", s.length ? `${s.length} × ${s.width ?? "?"} m` : null) +
    row("Call sign", s.callsign && esc(s.callsign)) +
    (s.imo ? row("IMO", s.imo) : "") +
    row("Position", s.lat == null ? "not received yet" : `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`) +
    row("Messages", s.msgs) +
    row("Last heard", ago(s.seenAgo)) +
    `</dl>` +
    link(`https://www.marinetraffic.com/en/ais/details/ships/mmsi:${s.mmsi}`, "MarineTraffic") +
    link(`https://www.vesselfinder.com/vessels/details/${s.mmsi}`, "VesselFinder");
}

function renderDetails() {
  const box = $("details");
  const found = findSelected();
  if (!found) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = `<button class="close" title="Close">×</button>` +
    (found.kind === "plane" ? planeDetails(found.item) : shipDetails(found.item));
  box.querySelector(".close").onclick = () => select(null, false);
}

function statusClass(text) {
  return /busy|missing|no dongle|stopped/i.test(text) ? "bad" : /receiving|listening|replay/i.test(text) ? "ok" : "";
}

function renderStatus() {
  const st = $("status");
  st.textContent = latest.status;
  st.className = "status " + (latest.source === "demo" ? "demo" : statusClass(latest.status));
  for (const name of ["planes", "ships"]) {
    const el = $(`rx-${name}`);
    const rx = latest.receivers?.[name];
    const used = mode === "both" || mode === name;
    el.hidden = !rx || !used;
    if (el.hidden) continue;
    const label = name === "planes" ? "Planes (1090 MHz)" : "Ships (162 MHz)";
    el.textContent = `${label}: ${rx.status}${rx.secondsLeft != null && rx.active ? ` · switching in ${rx.secondsLeft}s` : ""}`;
    el.className = "status rx " + statusClass(rx.status);
  }
}

function renderPanel() {
  if (!latest) return;
  renderStatus();

  const list = latest.aircraft;
  $("stat-aircraft").textContent = list.length;
  $("stat-ships").textContent = latest.ships.length;
  $("stat-rate").textContent = latest.rate.toFixed(1);
  $("stat-shipmsgs").textContent = latest.shipMessages;
  $("dist-col").textContent = latest.receiver ? "km" : "msgs";
  $("count-aircraft").textContent = `(${list.filter((a) => a.lat != null).length} on map)`;
  $("count-ships").textContent = `(${latest.ships.filter((s) => s.lat != null).length} on map)`;
  $("empty").hidden = list.length > 0;
  $("ship-empty").hidden = latest.ships.length > 0;

  const rows = [...list].sort((a, b) => (a.callsign || a.icao).localeCompare(b.callsign || b.icao));
  $("list").querySelector("tbody").innerHTML = rows.map((a) => {
    const key = `plane:${a.icao}`;
    const cls = [key === selected && "selected", a.lat == null && "nopos"].filter(Boolean).join(" ");
    return `<tr class="${cls}" data-key="${key}">` +
      `<td><span class="swatch" style="background:${altColor(a.altitude)}"></span>${esc(a.callsign || a.icao)}</td>` +
      `<td>${a.altitude?.toLocaleString() ?? "-"}</td><td>${a.speed ?? "-"}</td>` +
      `<td>${latest.receiver ? (a.distanceKm ?? "-") : a.msgs}</td><td>${Math.round(a.seenAgo)}s</td></tr>`;
  }).join("");

  const shipRows = [...latest.ships].sort((a, b) => String(a.name ?? "~" + a.mmsi).localeCompare(String(b.name ?? "~" + b.mmsi)));
  $("ship-list").querySelector("tbody").innerHTML = shipRows.map((s) => {
    const key = `ship:${s.mmsi}`;
    const cls = [key === selected && "selected", s.lat == null && "nopos"].filter(Boolean).join(" ");
    const type = (SHIP_COLORS[s.category] ?? SHIP_COLORS.other)[1];
    return `<tr class="${cls}" data-key="${key}">` +
      `<td><span class="swatch" style="background:${shipColor(s)}"></span>${esc(s.name || s.mmsi)}</td>` +
      `<td>${esc(type)}</td><td>${s.speed ?? "-"}</td><td>${s.seenAgo < 90 ? `${s.seenAgo}s` : `${Math.round(s.seenAgo / 60)}m`}</td></tr>`;
  }).join("");
  renderDetails();
}

for (const id of ["list", "ship-list"]) {
  $(id).addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (tr) select(tr.dataset.key);
  });
}

// ---------------------------------------------------------------- live data

function connect() {
  const events = new EventSource("events");
  events.onmessage = (e) => {
    latest = JSON.parse(e.data);
    if (!modeRequest && latest.mode && latest.mode !== mode) applyMode(latest.mode);
    const count = positioned().length;
    if (autoFit && count !== lastFitCount) {
      lastFitCount = count;
      if (!fitAll() && latest.receiver) {
        [view.cx, view.cy] = project(latest.receiver.lat, latest.receiver.lon);
      }
    }
    render();
    renderPanel();
  };
  events.onerror = () => {
    const st = $("status");
    st.textContent = "Lost connection to the server. Is `npm start` still running?";
    st.className = "status bad";
  };
}

setBasemap(basemap);
loadMap();
connect();
