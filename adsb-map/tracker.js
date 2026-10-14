// Keeps the current state of every aircraft heard. Times are in seconds.
import { decode, cprGlobal, cprLocal, distanceKm } from "./decoder.js";

const FORGET_AFTER = 120;   // drop aircraft not heard for this long
const PAIR_WINDOW = 10;     // max seconds between an even/odd position pair
const LOCAL_WINDOW = 30;    // reuse the last fix as reference for this long
const TRAIL_POINTS = 200;
const MAX_RANGE_KM = 500;   // ADS-B doesn't reach further than this from a ground antenna

export class Tracker {
  constructor({ refLat = null, refLon = null } = {}) {
    this.ref = refLat != null && refLon != null ? { lat: refLat, lon: refLon } : null;
    this.planes = new Map();
    this.raw = 0;
    this.good = 0;
    this.recent = []; // timestamps of good messages, for the rate display
  }

  handle(hex, now) {
    this.raw++;
    const m = decode(hex);
    if (!m) return;
    this.good++;
    this.recent.push(now);

    let a = this.planes.get(m.icao);
    if (!a) {
      a = { icao: m.icao, callsign: null, altitude: null, speed: null, heading: null,
        verticalRate: null, lat: null, lon: null, lastPos: null, trail: [],
        even: null, odd: null, msgs: 0, firstSeen: now };
      this.planes.set(m.icao, a);
    }
    a.msgs++;
    a.lastSeen = now;
    if (m.callsign) a.callsign = m.callsign;
    if (m.altitude != null) a.altitude = m.altitude;
    if (m.speed != null) a.speed = m.speed;
    if (m.heading != null) a.heading = m.heading;
    if (m.verticalRate != null) a.verticalRate = m.verticalRate;
    if (m.cpr) this.position(a, m.cpr, now);
  }

  position(a, cpr, now) {
    let pos = null;
    if (a.lastPos != null && now - a.lastPos < LOCAL_WINDOW) {
      pos = cprLocal(cpr, a.lat, a.lon);
    } else {
      a[cpr.odd ? "odd" : "even"] = { ...cpr, t: now };
      if (a.even && a.odd && Math.abs(a.even.t - a.odd.t) < PAIR_WINDOW) {
        pos = cprGlobal(a.even, a.odd, a.odd.t >= a.even.t);
      } else if (this.ref) {
        pos = cprLocal(cpr, this.ref.lat, this.ref.lon);
      }
    }
    if (!pos) return;
    if (this.ref && distanceKm(pos.lat, pos.lon, this.ref.lat, this.ref.lon) > MAX_RANGE_KM) return;
    // a jump faster than ~Mach 3 is a decoding glitch, not the aircraft
    if (a.lastPos != null &&
        distanceKm(pos.lat, pos.lon, a.lat, a.lon) > 1 + 1.0 * (now - a.lastPos)) {
      a.lastPos = null; // start over with a fresh even/odd pair
      return;
    }
    a.lat = pos.lat;
    a.lon = pos.lon;
    a.lastPos = now;
    a.trail.push([+pos.lat.toFixed(5), +pos.lon.toFixed(5)]);
    if (a.trail.length > TRAIL_POINTS) a.trail.shift();
  }

  /** Inject an already-decoded aircraft state (demo mode). */
  put(state, now) {
    const a = this.planes.get(state.icao) ?? { trail: [], msgs: 0, firstSeen: now };
    Object.assign(a, state, { lastSeen: now, lastPos: now });
    a.msgs++;
    a.trail.push([+state.lat.toFixed(5), +state.lon.toFixed(5)]);
    if (a.trail.length > TRAIL_POINTS) a.trail.shift();
    this.planes.set(state.icao, a);
    this.good++;
    this.raw++;
    this.recent.push(now);
  }

  snapshot(now) {
    for (const [icao, a] of this.planes) if (now - a.lastSeen > FORGET_AFTER) this.planes.delete(icao);
    this.recent = this.recent.filter((t) => now - t < 10);
    const aircraft = [...this.planes.values()].map((a) => ({
      icao: a.icao, callsign: a.callsign, altitude: a.altitude,
      speed: a.speed == null ? null : Math.round(a.speed),
      heading: a.heading == null ? null : Math.round(a.heading),
      verticalRate: a.verticalRate, lat: a.lat, lon: a.lon, trail: a.trail, msgs: a.msgs,
      seenAgo: +(now - a.lastSeen).toFixed(1),
      posAgo: a.lastPos == null ? null : +(now - a.lastPos).toFixed(1),
      distanceKm: this.ref && a.lat != null
        ? +distanceKm(a.lat, a.lon, this.ref.lat, this.ref.lon).toFixed(1) : null,
    }));
    return { raw: this.raw, good: this.good, rate: this.recent.length / 10, aircraft };
  }
}
