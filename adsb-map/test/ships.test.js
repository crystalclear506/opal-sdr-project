import { test } from "node:test";
import assert from "node:assert/strict";
import { ShipTracker, shipCategory } from "../ships.js";

test("position report then static data build one ship", () => {
  const t = new ShipTracker();
  t.handle({ class: "AIS", type: 1, mmsi: 567000001, lat: 13.6, lon: 100.55, speed: 8.4,
    course: 182.3, heading: 181, status_text: "Under way using engine" }, 100);
  t.handle({ class: "AIS", type: 5, mmsi: 567000001, shipname: "SIAM STAR@@@", callsign: "HSAB",
    shiptype: 70, shiptype_text: "Cargo", destination: "BANGKOK", to_bow: 120, to_stern: 30,
    to_port: 10, to_starboard: 12 }, 101);
  const [s] = t.snapshot(101).ships;
  assert.equal(s.name, "SIAM STAR");
  assert.equal(s.category, "cargo");
  assert.equal(s.length, 150);
  assert.equal(s.width, 22);
  assert.equal(s.speed, 8.4);
  assert.equal(s.heading, 181);
  assert.equal(s.status, "Under way using engine");
  assert.equal(s.trail.length, 1);
});

test("'not available' values are ignored", () => {
  const t = new ShipTracker();
  t.handle({ type: 1, mmsi: 1, lat: 91, lon: 181, speed: 102.3, course: 360, heading: 511 }, 0);
  const [s] = t.snapshot(0).ships;
  assert.equal(s.lat, null);
  assert.equal(s.speed, null);
  assert.equal(s.course, null);
  assert.equal(s.heading, null);
});

test("ships at anchor don't grow a trail", () => {
  const t = new ShipTracker();
  t.handle({ type: 1, mmsi: 2, lat: 13.5, lon: 100.6 }, 0);
  t.handle({ type: 1, mmsi: 2, lat: 13.50001, lon: 100.60001 }, 10);
  t.handle({ type: 1, mmsi: 2, lat: 13.51, lon: 100.6 }, 20);
  assert.equal(t.snapshot(20).ships[0].trail.length, 2);
});

test("categories", () => {
  assert.equal(shipCategory(84), "tanker");
  assert.equal(shipCategory(60), "passenger");
  assert.equal(shipCategory(30), "fishing");
  assert.equal(shipCategory(52), "tug");
  assert.equal(shipCategory(null, 4), "station");
  assert.equal(shipCategory(undefined), "other");
});

test("real AIS-catcher JSON output", () => {
  const t = new ShipTracker();
  t.handle({ class: "AIS", type: 1, mmsi: 366053209, status: 3, status_text: "Restricted maneuverability",
    speed: 0, lon: -122.341614, lat: 37.80212, course: 219.300003, heading: 1 }, 0);
  t.handle({ class: "AIS", type: 5, mmsi: 351759000, imo: 9134270, callsign: "3FOF8", shipname: "EVER DIADEM",
    shiptype: 70, shiptype_text: "Cargo ships - all ships of this type", to_bow: 225, to_stern: 70,
    to_port: 1, to_starboard: 31, destination: "NEW YORK" }, 0);
  const [a, b] = t.snapshot(0).ships;
  assert.equal(a.status, "Restricted maneuverability");
  assert.equal(a.lat, 37.80212);
  assert.equal(b.name, "EVER DIADEM");
  assert.equal(b.shiptypeText, "Cargo ships");
  assert.equal(b.category, "cargo");
  assert.equal(b.length, 295);
});
