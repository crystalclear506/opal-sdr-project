// Favorite frequencies, kept in a JSON file next to the server.
import fs from "node:fs";
import { MODES, MIN_FREQ, MAX_FREQ } from "./dsp.js";

export const STARTERS = [
  { name: "Airband 121.100", freq: 121.1e6, mode: "am", squelch: -45, group: "ATC" },
  { name: "Airband 122.350", freq: 122.35e6, mode: "am", squelch: -45, group: "ATC" },
];

export class Favorites {
  constructor(file, starters = STARTERS) {
    this.file = file;
    this.list = [];
    try {
      this.list = JSON.parse(fs.readFileSync(file, "utf8")).map(clean).filter(Boolean);
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`favorites: can't read ${file} (${err.message}); starting empty`);
      else this.list = starters.map(clean);
    }
    this.nextId = Math.max(0, ...this.list.map((f) => f.id ?? 0)) + 1;
    for (const f of this.list) f.id ??= this.nextId++;
    this.list.sort(byGroupThenFreq);
  }

  /** Group names in display order (ungrouped last). */
  groups() {
    return [...new Set(this.list.map((f) => f.group))];
  }

  inGroup(group) {
    return this.list.filter((f) => f.group === group);
  }

  /** Adds a favorite, or updates the one already on this frequency + mode. Returns it, or throws. */
  save(input) {
    const fav = clean(input);
    if (!fav) throw new Error("need a frequency between 0.5 and 1766 MHz and a valid mode");
    const same = this.list.find((f) => f.freq === fav.freq && f.mode === fav.mode);
    if (same) Object.assign(same, fav, { id: same.id });
    else this.list.push({ ...fav, id: this.nextId++ });
    this.list.sort(byGroupThenFreq);
    this.write();
    return same ?? this.list.find((f) => f.freq === fav.freq && f.mode === fav.mode);
  }

  remove(id) {
    const before = this.list.length;
    this.list = this.list.filter((f) => f.id !== id);
    if (this.list.length !== before) this.write();
    return this.list.length !== before;
  }

  write() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.list, null, 2) + "\n");
    fs.renameSync(tmp, this.file);
  }
}

/** Groups A-Z with ungrouped ("") last, then by frequency. */
function byGroupThenFreq(a, b) {
  if (a.group !== b.group) {
    if (!a.group) return 1;
    if (!b.group) return -1;
    return a.group.localeCompare(b.group);
  }
  return a.freq - b.freq;
}

function clean(f) {
  const freq = Math.round(Number(f?.freq));
  if (!(freq >= MIN_FREQ && freq <= MAX_FREQ) || !MODES.includes(f.mode)) return null;
  const name = String(f.name ?? "").trim().slice(0, 60) || `${(freq / 1e6).toFixed(3)} MHz`;
  const group = String(f.group ?? "").trim().slice(0, 30);
  const out = { name, freq, mode: f.mode, group };
  if (Number.isInteger(f.id)) out.id = f.id;
  if (Number.isFinite(f.squelch)) out.squelch = Math.round(f.squelch);
  return out;
}
