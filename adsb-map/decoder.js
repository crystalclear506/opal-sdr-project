// Mode S / ADS-B (DF17/18) decoding: checksum, identity, altitude, velocity, CPR positions.

const CRC_GENERATOR = 0xfff409;
const CALLSIGN_CHARS = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######";

export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// Bits are numbered from 1, as in the ICAO documents.
function bits(bytes, start, length) {
  let value = 0;
  for (let i = start - 1; i < start - 1 + length; i++) {
    value = value * 2 + ((bytes[i >> 3] >> (7 - (i & 7))) & 1);
  }
  return value;
}

export function checksumOk(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length - 3; i++) {
    crc ^= bytes[i] << 16;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x800000 ? (crc << 1) ^ CRC_GENERATOR : crc << 1;
      crc &= 0xffffff;
    }
  }
  const n = bytes.length;
  return crc === ((bytes[n - 3] << 16) | (bytes[n - 2] << 8) | bytes[n - 1]);
}

/** Decodes one hex message. Returns null unless it is a valid 112-bit ADS-B message. */
export function decode(hex) {
  if (!/^[0-9A-Fa-f]{28}$/.test(hex)) return null;
  const b = hexToBytes(hex);
  const df = bits(b, 1, 5);
  if ((df !== 17 && df !== 18) || !checksumOk(b)) return null;

  const msg = {
    icao: bits(b, 9, 24).toString(16).toUpperCase().padStart(6, "0"),
    tc: bits(b, 33, 5),
  };
  const tc = msg.tc;

  if (tc >= 1 && tc <= 4) {
    let callsign = "";
    for (let i = 0; i < 8; i++) callsign += CALLSIGN_CHARS[bits(b, 41 + i * 6, 6)];
    msg.callsign = callsign.replace(/[#_ ]+$/g, "").replace(/#/g, "");
  } else if ((tc >= 9 && tc <= 18) || (tc >= 20 && tc <= 22)) {
    const altCode = bits(b, 41, 12);
    if (tc >= 20) {
      msg.altitude = Math.round(altCode * 3.28084);
    } else if (bits(b, 48, 1) === 1) {
      const n = ((altCode & 0xfe0) >> 1) | (altCode & 0x0f);
      msg.altitude = n * 25 - 1000;
    }
    msg.cpr = {
      odd: bits(b, 54, 1) === 1,
      lat: bits(b, 55, 17) / 131072,
      lon: bits(b, 72, 17) / 131072,
    };
  } else if (tc === 19) {
    const subtype = bits(b, 38, 3);
    const vr = bits(b, 70, 9);
    if (vr !== 0) msg.verticalRate = (vr - 1) * 64 * (bits(b, 69, 1) ? -1 : 1);
    if (subtype === 1 || subtype === 2) {
      const ew = bits(b, 47, 10), ns = bits(b, 58, 10);
      if (ew !== 0 && ns !== 0) {
        const mult = subtype === 2 ? 4 : 1;
        const vEW = (ew - 1) * mult * (bits(b, 46, 1) ? -1 : 1);
        const vNS = (ns - 1) * mult * (bits(b, 57, 1) ? -1 : 1);
        msg.speed = Math.hypot(vEW, vNS);
        msg.heading = (Math.atan2(vEW, vNS) * 180 / Math.PI + 360) % 360;
      }
    } else if (subtype === 3 || subtype === 4) {
      if (bits(b, 46, 1)) msg.heading = bits(b, 47, 10) * 360 / 1024;
      const as = bits(b, 59, 10);
      if (as !== 0) msg.speed = (as - 1) * (subtype === 4 ? 4 : 1);
    }
  }
  return msg;
}

// ---------------------------------------------------------------- CPR position decoding

const mod = (a, b) => ((a % b) + b) % b;

function NL(lat) {
  const abs = Math.abs(lat);
  if (abs === 0) return 59;
  if (abs === 87) return 2;
  if (abs > 87) return 1;
  const a = 1 - Math.cos(Math.PI / 30);
  const c = Math.cos((Math.PI / 180) * abs) ** 2;
  return Math.floor((2 * Math.PI) / Math.acos(1 - a / c));
}

/** Position from an even + odd message pair; `newerIsOdd` says which arrived last. */
export function cprGlobal(even, odd, newerIsOdd) {
  const j = Math.floor(59 * even.lat - 60 * odd.lat + 0.5);
  let latE = (360 / 60) * (mod(j, 60) + even.lat);
  let latO = (360 / 59) * (mod(j, 59) + odd.lat);
  if (latE >= 270) latE -= 360;
  if (latO >= 270) latO -= 360;
  if (NL(latE) !== NL(latO)) return null; // the pair straddles a zone boundary

  const lat = newerIsOdd ? latO : latE;
  const nl = NL(lat);
  const ni = Math.max(newerIsOdd ? nl - 1 : nl, 1);
  const m = Math.floor(even.lon * (nl - 1) - odd.lon * nl + 0.5);
  let lon = (360 / ni) * (mod(m, ni) + (newerIsOdd ? odd.lon : even.lon));
  if (lon >= 180) lon -= 360;
  return { lat, lon };
}

/** Position from a single message, given a reference point within ~300 km. */
export function cprLocal(cpr, refLat, refLon) {
  const dLat = 360 / (cpr.odd ? 59 : 60);
  const j = Math.floor(refLat / dLat) + Math.floor(mod(refLat, dLat) / dLat - cpr.lat + 0.5);
  const lat = dLat * (j + cpr.lat);
  const ni = NL(lat) - (cpr.odd ? 1 : 0);
  const dLon = ni > 0 ? 360 / ni : 360;
  const m = Math.floor(refLon / dLon) + Math.floor(mod(refLon, dLon) / dLon - cpr.lon + 0.5);
  return { lat, lon: dLon * (m + cpr.lon) };
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
