import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, cprGlobal, cprLocal } from "../decoder.js";
import { Tracker } from "../tracker.js";

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("identification", () => {
  const m = decode("8D4840D6202CC371C32CE0576098");
  assert.equal(m.icao, "4840D6");
  assert.equal(m.callsign, "KLM1023");
});

test("corrupted and short messages are rejected", () => {
  assert.equal(decode("8D4840D6202CC371C32CE0576099"), null);
  assert.equal(decode("5D4840D6123456"), null);
});

test("altitude and CPR", () => {
  const e = decode("8D40621D58C382D690C8AC2863A7");
  const o = decode("8D40621D58C386435CC412692AD6");
  assert.equal(e.altitude, 38000);
  assert.equal(e.cpr.odd, false);
  assert.equal(o.cpr.odd, true);
  const pe = cprGlobal(e.cpr, o.cpr, false);
  close(pe.lat, 52.2572021484375);
  close(pe.lon, 3.91937255859375);
  const po = cprGlobal(e.cpr, o.cpr, true);
  close(po.lat, 52.26578);
  close(po.lon, 3.93891);
  const pl = cprLocal(e.cpr, 52.258, 3.918);
  close(pl.lat, 52.2572021484375);
  close(pl.lon, 3.91937255859375);
});

test("velocity", () => {
  const v = decode("8D485020994409940838175B284F");
  close(v.speed, 159.2, 0.1);
  close(v.heading, 182.88, 0.01);
  assert.equal(v.verticalRate, -832);
});

test("tracker builds an aircraft from messages", () => {
  const t = new Tracker();
  t.handle("8D40621D58C382D690C8AC2863A7", 1000);
  t.handle("8D40621D58C386435CC412692AD6", 1001);
  const [a] = t.snapshot(1001).aircraft;
  assert.equal(a.icao, "40621D");
  assert.equal(a.altitude, 38000);
  close(a.lat, 52.26578);
  assert.equal(t.good, 2);
});
