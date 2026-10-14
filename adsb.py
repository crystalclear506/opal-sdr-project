#!/usr/bin/env python
"""
adsb.py - see the aircraft around you on 1090 MHz with the RTL-SDR Blog V4.

  python adsb.py                          live table of aircraft
  python adsb.py --lat 37.5 --lon 127.0   also show distance from you (and faster positions)
  python adsb.py --log raw.txt            also save every raw message
  python adsb.py --replay raw.txt         decode a saved log instead of the radio

bin/rtl_adsb.exe pulls the raw Mode S messages out of the air; this script
checks them and decodes call sign, altitude, speed, heading and position.
For best results use a vertical antenna about 6.9 cm per arm, high up / at a window.
"""
import argparse
import math
import os
import queue
import subprocess
import sys
import threading
import time

import pyModeS as pms

HERE = os.path.dirname(os.path.abspath(__file__))
RTL_ADSB = os.path.join(HERE, "bin", "rtl_adsb.exe")
FORGET_AFTER = 60   # seconds without a message before an aircraft leaves the table
PAIR_WINDOW = 10    # seconds an even/odd position pair may be apart


class Aircraft:
    def __init__(self, icao):
        self.icao = icao
        self.callsign = self.alt = self.speed = self.heading = self.vrate = None
        self.lat = self.lon = self.last_fix = None
        self.even = self.odd = None     # (message, time) for position decoding
        self.msgs = 0
        self.first = self.last = time.time()


def distance_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


class Tracker:
    def __init__(self, ref_lat=None, ref_lon=None):
        self.planes = {}
        self.ref = (ref_lat, ref_lon) if ref_lat is not None and ref_lon is not None else None
        self.raw = self.valid = 0

    def handle(self, msg, now):
        self.raw += 1
        if len(msg) != 28 or pms.df(msg) not in (17, 18) or pms.crc(msg) != 0:
            return  # short Mode S replies and corrupted messages can't be checked; skip them
        self.valid += 1
        icao = pms.icao(msg)
        ac = self.planes.get(icao) or self.planes.setdefault(icao, Aircraft(icao))
        ac.msgs += 1
        ac.last = now
        tc = pms.adsb.typecode(msg)

        if 1 <= tc <= 4:
            ac.callsign = pms.adsb.callsign(msg).strip("_ ")
        elif 9 <= tc <= 18 or 20 <= tc <= 22:
            ac.alt = pms.adsb.altitude(msg)
            self._position(ac, msg, now)
        elif tc == 19:
            v = pms.adsb.velocity(msg)
            if v:
                ac.speed, ac.heading, ac.vrate = v[0], v[1], v[2]

    def _position(self, ac, msg, now):
        if ac.lat is not None and now - ac.last_fix < 30:
            pos = pms.adsb.position_with_ref(msg, ac.lat, ac.lon)
        else:
            if pms.adsb.oe_flag(msg):
                ac.odd = (msg, now)
            else:
                ac.even = (msg, now)
            pos = None
            if ac.even and ac.odd and abs(ac.even[1] - ac.odd[1]) < PAIR_WINDOW:
                pos = pms.adsb.position(ac.even[0], ac.odd[0], ac.even[1], ac.odd[1])
            elif self.ref:
                pos = pms.adsb.position_with_ref(msg, *self.ref)
                if pos and distance_km(*pos, *self.ref) > 400:   # out of radio range: wrong zone
                    pos = None
        if pos and pos[0] is not None:
            ac.lat, ac.lon = pos
            ac.last_fix = now

    def forget_old(self, now):
        for icao in [i for i, a in self.planes.items() if now - a.last > FORGET_AFTER]:
            del self.planes[icao]


def fmt(v, spec, none="-"):
    return none if v is None else format(v, spec)


def draw(tracker, started, status):
    now = time.time()
    rows = sorted(tracker.planes.values(), key=lambda a: a.last, reverse=True)
    out = ["\x1b[H\x1b[J",
           f"ADS-B 1090 MHz  |  running {now - started:5.0f} s  |  messages: {tracker.raw} raw, "
           f"{tracker.valid} good  |  aircraft now: {len(rows)}  |  {status}",
           "",
           f"{'ICAO':6} {'call':8} {'alt ft':>7} {'kt':>4} {'hdg':>4} {'ft/min':>7} "
           f"{'lat':>9} {'lon':>10} {'km':>5} {'msgs':>5} {'age':>4}"]
    for a in rows:
        km = (distance_km(a.lat, a.lon, *tracker.ref)
              if tracker.ref and a.lat is not None else None)
        out.append(f"{a.icao:6} {a.callsign or '':8} {fmt(a.alt, '7d'):>7} {fmt(a.speed, '4.0f'):>4} "
                   f"{fmt(a.heading, '4.0f'):>4} {fmt(a.vrate, '7d'):>7} {fmt(a.lat, '9.4f'):>9} "
                   f"{fmt(a.lon, '10.4f'):>10} {fmt(km, '5.0f'):>5} {a.msgs:5d} {now - a.last:4.0f}")
    if not rows:
        out.append("\n(no aircraft yet - this can take a minute; a window or rooftop helps a lot)")
    out.append("\nCtrl+C to stop.")
    sys.stdout.write("\n".join(out) + "\n")
    sys.stdout.flush()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--gain", default="49.6", help="tuner gain in dB (default 49.6, the maximum)")
    p.add_argument("--ppm", type=int, default=0)
    p.add_argument("--lat", type=float, help="your latitude, for distances")
    p.add_argument("--lon", type=float, help="your longitude, for distances")
    p.add_argument("--log", help="append raw messages to this file")
    p.add_argument("--replay", help="decode a saved raw log instead of using the radio")
    p.add_argument("--seconds", type=float, help="stop after this many seconds")
    args = p.parse_args()

    os.system("")  # turns on ANSI screen control in the Windows console
    tracker = Tracker(args.lat, args.lon)

    if args.replay:
        with open(args.replay) as f:
            for line in f:
                line = line.strip()
                if line.startswith("*") and line.endswith(";"):
                    tracker.handle(line[1:-1].upper(), time.time())
        draw(tracker, time.time(), f"replayed {args.replay}")
        return

    cmd = [RTL_ADSB, "-g", str(args.gain)]
    if args.ppm:
        cmd += ["-p", str(args.ppm)]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, bufsize=1)
    lines = queue.Queue()
    errors = []

    def pump(stream, sink):
        for line in stream:
            sink(line.strip())

    threading.Thread(target=pump, args=(proc.stdout, lines.put), daemon=True).start()
    threading.Thread(target=pump, args=(proc.stderr, errors.append), daemon=True).start()

    log = open(args.log, "a") if args.log else None
    started = last_draw = time.time()
    try:
        while args.seconds is None or time.time() - started < args.seconds:
            try:
                line = lines.get(timeout=0.5)
                if line.startswith("*") and line.endswith(";"):
                    tracker.handle(line[1:-1].upper(), time.time())
                    if log:
                        log.write(f"{time.time():.3f} {line}\n")
            except queue.Empty:
                pass
            if proc.poll() is not None and lines.empty():
                time.sleep(0.3)
                msg = " / ".join(e for e in errors if e) or "no output"
                if "usb_open error" in msg:
                    msg += "\n\nThe dongle is busy - close sdr.py, SDR++, SDR# etc. and try again."
                sys.exit(f"rtl_adsb stopped: {msg}")
            now = time.time()
            if now - last_draw >= 1:
                tracker.forget_old(now)
                draw(tracker, started, "listening")
                last_draw = now
    except KeyboardInterrupt:
        pass
    finally:
        proc.terminate()
        if log:
            log.close()
    print(f"\nDone: {tracker.raw} raw messages, {tracker.valid} passed the checksum, "
          f"{len(tracker.planes)} aircraft in the table at the end.")


if __name__ == "__main__":
    main()
