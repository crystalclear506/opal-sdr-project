// Keeps the current state of every vessel heard on AIS. Input is AIS-catcher's JSON (-o 5).
// Times are in seconds.

const FORGET_AFTER = 3600;   // anchored ships report every few minutes, so keep them a while
const TRAIL_POINTS = 300;
const TRAIL_MIN_MOVE_DEG = 0.0002;  // ~20 m; don't grow trails for ships swinging at anchor

export function shipCategory(type, msgType) {
  if (msgType === 4) return "station";
  if (msgType === 21) return "aid";
  if (type == null) return "other";
  if (type >= 60 && type <= 69) return "passenger";
  if (type >= 70 && type <= 79) return "cargo";
  if (type >= 80 && type <= 89) return "tanker";
  if (type === 30) return "fishing";
  if ([31, 32, 52, 53].includes(type)) return "tug";
  if (type >= 40 && type <= 49) return "highspeed";
  if ([35, 50, 51, 55].includes(type)) return "special";
  if (type === 36 || type === 37) return "pleasure";
  return "other";
}

const clean = (s) => (typeof s === "string" ? s.replace(/@+$/g, "").trim() : "") || null;

export class ShipTracker {
  constructor() {
    this.ships = new Map();
    this.messages = 0;
    this.recent = [];
  }

  handle(m, now) {
    if (!m || typeof m.mmsi !== "number" || (m.class && m.class !== "AIS")) return;
    this.messages++;
    this.recent.push(now);

    let s = this.ships.get(m.mmsi);
    if (!s) {
      s = { mmsi: m.mmsi, name: null, callsign: null, imo: null, shiptype: null, shiptypeText: null,
        category: "other", msgType: m.type, status: null, destination: null, length: null, width: null,
        lat: null, lon: null, speed: null, course: null, heading: null, trail: [], msgs: 0,
        firstSeen: now, lastSeen: now, lastPos: null };
      this.ships.set(m.mmsi, s);
    }
    s.msgs++;
    s.lastSeen = now;
    if (m.type === 4 || m.type === 21) s.msgType = m.type;

    const name = clean(m.shipname) ?? clean(m.name);
    if (name) s.name = name;
    if (clean(m.callsign)) s.callsign = clean(m.callsign);
    if (m.imo) s.imo = m.imo;
    if (clean(m.destination)) s.destination = clean(m.destination);
    if (typeof m.shiptype === "number" && m.shiptype > 0) {
      s.shiptype = m.shiptype;
      s.shiptypeText = clean(m.shiptype_text)?.split(" - ")[0] ?? null;
    }
    if (typeof m.aid_type === "number") s.shiptypeText = clean(m.aid_type_text) ?? "Aid to navigation";
    s.category = shipCategory(s.shiptype, s.msgType);
    if (m.status_text && [1, 2, 3].includes(m.type)) s.status = clean(m.status_text);
    if (m.to_bow != null && m.to_stern != null && m.to_bow + m.to_stern > 0) s.length = m.to_bow + m.to_stern;
    if (m.to_port != null && m.to_starboard != null && m.to_port + m.to_starboard > 0) s.width = m.to_port + m.to_starboard;
    if (typeof m.speed === "number" && m.speed < 102.2) s.speed = m.speed;
    if (typeof m.course === "number" && m.course < 360) s.course = m.course;
    if (typeof m.heading === "number" && m.heading < 360) s.heading = m.heading;

    if (typeof m.lat === "number" && typeof m.lon === "number" &&
        Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 180 && !(m.lat === 0 && m.lon === 0)) {
      const last = s.trail.at(-1);
      if (!last || Math.abs(last[0] - m.lat) + Math.abs(last[1] - m.lon) > TRAIL_MIN_MOVE_DEG) {
        s.trail.push([+m.lat.toFixed(5), +m.lon.toFixed(5)]);
        if (s.trail.length > TRAIL_POINTS) s.trail.shift();
      }
      s.lat = m.lat;
      s.lon = m.lon;
      s.lastPos = now;
    }
  }

  /** Inject a ship state directly (demo mode). */
  put(state, now) {
    this.handle({ class: "AIS", ...state }, now);
  }

  snapshot(now) {
    for (const [mmsi, s] of this.ships) if (now - s.lastSeen > FORGET_AFTER) this.ships.delete(mmsi);
    this.recent = this.recent.filter((t) => now - t < 60);
    const ships = [...this.ships.values()].map(({ firstSeen, lastSeen, lastPos, ...s }) => ({
      ...s,
      speed: s.speed == null ? null : +s.speed.toFixed(1),
      seenAgo: Math.round(now - lastSeen),
      posAgo: lastPos == null ? null : Math.round(now - lastPos),
    }));
    return { messages: this.messages, rate: this.recent.length / 60, ships };
  }
}
