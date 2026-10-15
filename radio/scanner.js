// Hops through a list of channels and stops on whichever one is active, like a police scanner.
// Feed it each block's signal level; it says when to move on.

export const SETTLE_BLOCKS = 3;   // ignore blocks still in flight from the old frequency (~0.3 s)
export const DWELL_BLOCKS = 3;    // listen this long on a quiet channel before moving on (~0.3 s)
export const HOLD_BLOCKS = 20;    // after a transmission ends, wait this long for a reply (~2 s)

export class Scanner {
  constructor(group, channels) {
    if (!channels.length) throw new Error(`no channels in ${group || "this group"}`);
    this.group = group;
    this.channels = channels;
    this.index = -1;
  }

  get current() {
    return this.channels[this.index];
  }

  /** Moves to the next channel and returns it. */
  next() {
    this.index = (this.index + 1) % this.channels.length;
    this.settle = SETTLE_BLOCKS;
    this.quiet = 0;
    this.heard = false;
    return this.current;
  }

  /** One block's level in dB -> { settling: ignore this block, hop: time to call next() }. */
  block(level, squelch) {
    if (this.settle > 0) {
      this.settle--;
      return { settling: true, hop: false };
    }
    if (level >= squelch) {
      this.heard = true;
      this.quiet = 0;
    } else {
      this.quiet++;
    }
    const hop = this.channels.length > 1 && this.quiet >= (this.heard ? HOLD_BLOCKS : DWELL_BLOCKS);
    return { settling: false, hop };
  }

  /** True while parked on a channel that has been active. */
  get stopped() {
    return this.heard && this.quiet < HOLD_BLOCKS;
  }
}
