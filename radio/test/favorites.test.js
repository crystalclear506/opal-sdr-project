import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Favorites } from "../favorites.js";

const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radio-favs-"));
  dirs.push(dir);
  return path.join(dir, "favorites.json");
}

test("first run starts with the starter list and saves to disk", () => {
  const file = tempFile();
  const f = new Favorites(file, [{ name: "Tower", freq: 118.1e6, mode: "am" }]);
  assert.equal(f.list.length, 1);
  assert.equal(f.list[0].id, 1);
  f.save({ name: "Ground", freq: 121.9e6, mode: "am", squelch: -44.6 });
  const again = new Favorites(file);
  assert.deepEqual(again.list.map((x) => [x.name, x.freq, x.squelch]), [["Tower", 118.1e6, undefined], ["Ground", 121.9e6, -45]]);
});

test("saving the same frequency and mode renames instead of duplicating", () => {
  const f = new Favorites(tempFile(), []);
  const a = f.save({ name: "A", freq: 121.1e6, mode: "am" });
  const b = f.save({ name: "Approach", freq: 121.1e6, mode: "am" });
  assert.equal(f.list.length, 1);
  assert.equal(a.id, b.id);
  assert.equal(f.list[0].name, "Approach");
  f.save({ name: "Same freq, FM", freq: 121.1e6, mode: "nfm" });
  assert.equal(f.list.length, 2);
});

test("list stays sorted by frequency, ids stay unique after removal", () => {
  const f = new Favorites(tempFile(), []);
  f.save({ freq: 133e6, mode: "am" });
  const low = f.save({ freq: 118e6, mode: "am" });
  assert.deepEqual(f.list.map((x) => x.freq), [118e6, 133e6]);
  assert.equal(f.list[0].name, "118.000 MHz");
  assert.equal(f.remove(low.id), true);
  assert.equal(f.remove(low.id), false);
  const next = f.save({ freq: 120e6, mode: "am" });
  assert.notEqual(next.id, low.id);
});

test("groups sort A-Z with ungrouped last, and can be listed", () => {
  const f = new Favorites(tempFile(), []);
  f.save({ name: "loose", freq: 100e6, mode: "wfm" });
  f.save({ name: "fire", freq: 160e6, mode: "nfm", group: "First responders" });
  f.save({ name: "tower", freq: 118e6, mode: "am", group: "ATC" });
  f.save({ name: "police", freq: 150e6, mode: "nfm", group: " First responders " });
  assert.deepEqual(f.list.map((x) => x.name), ["tower", "police", "fire", "loose"]);
  assert.deepEqual(f.groups(), ["ATC", "First responders", ""]);
  assert.deepEqual(f.inGroup("First responders").map((x) => x.name), ["police", "fire"]);
});

test("bad input is refused", () => {
  const f = new Favorites(tempFile(), []);
  assert.throws(() => f.save({ freq: 5e9, mode: "am" }));
  assert.throws(() => f.save({ freq: 121e6, mode: "cw" }));
  assert.throws(() => f.save({ freq: "abc", mode: "am" }));
});
