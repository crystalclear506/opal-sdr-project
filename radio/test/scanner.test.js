import { test } from "node:test";
import assert from "node:assert/strict";
import { DWELL_BLOCKS, HOLD_BLOCKS, SETTLE_BLOCKS, Scanner } from "../scanner.js";

const chans = [{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "C" }];
const QUIET = -70, ACTIVE = -30, SQ = -45;

/** Feeds blocks until the scanner wants to hop; returns how many it took. */
function blocksUntilHop(s, level) {
  for (let n = 1; n < 1000; n++) if (s.block(level(n), SQ).hop) return n;
  return Infinity;
}

test("quiet channels are skipped after settle + dwell, wrapping around", () => {
  const s = new Scanner("G", chans);
  assert.equal(s.next().name, "A");
  assert.equal(blocksUntilHop(s, () => QUIET), SETTLE_BLOCKS + DWELL_BLOCKS);
  assert.equal(s.next().name, "B");
  s.next();
  assert.equal(s.next().name, "A");
});

test("blocks while settling are ignored, even if they look active", () => {
  const s = new Scanner("G", chans);
  s.next();
  for (let i = 0; i < SETTLE_BLOCKS; i++) assert.deepEqual(s.block(ACTIVE, SQ), { settling: true, hop: false });
  assert.equal(s.heard, false);
});

test("an active channel holds until it has been quiet for the hold time", () => {
  const s = new Scanner("G", chans);
  s.next();
  const talkFor = 10;
  const n = blocksUntilHop(s, (i) => (i <= SETTLE_BLOCKS + talkFor ? ACTIVE : QUIET));
  assert.equal(n, SETTLE_BLOCKS + talkFor + HOLD_BLOCKS);
});

test("a reply during the hold keeps the scanner on the channel", () => {
  const s = new Scanner("G", chans);
  s.next();
  for (let i = 0; i < SETTLE_BLOCKS + 2; i++) s.block(ACTIVE, SQ);
  for (let i = 0; i < HOLD_BLOCKS - 1; i++) assert.equal(s.block(QUIET, SQ).hop, false);
  s.block(ACTIVE, SQ);                                     // reply
  assert.equal(s.stopped, true);
  for (let i = 0; i < HOLD_BLOCKS - 1; i++) assert.equal(s.block(QUIET, SQ).hop, false);
  assert.equal(s.block(QUIET, SQ).hop, true);
});

test("a single channel never hops; an empty group is refused", () => {
  const s = new Scanner("G", [chans[0]]);
  s.next();
  assert.equal(blocksUntilHop(s, () => QUIET), Infinity);
  assert.throws(() => new Scanner("Empty", []), /no channels/);
});
