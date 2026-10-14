#!/usr/bin/env python
"""
sdr.py - a small receiver for the RTL-SDR Blog V4.

  python sdr.py 101.1M                 listen (mode is guessed from the frequency)
  python sdr.py 118.1M --mode am       pick the mode yourself: wfm nfm am usb lsb
  python sdr.py 162.55M --squelch -45  mute the noise until a signal shows up
  python sdr.py scan 118M 137M         sweep a range and list where signals are
  python sdr.py list                   things worth trying

While listening:
  Left/Right  tune down/up by one step     Up/Down  bigger/smaller step
  f           type a new frequency         m        change mode
  g / G       gain down / up               s / S    squelch down / up
  a           auto-squelch (just above the current noise)
  - / +       volume                       q / Esc  quit
"""
import argparse
import os
import queue
import re
import shutil
import sys
import threading
import time
import wave

import numpy as np
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "bin")  # RTL-SDR Blog V4 driver DLLs live here
if os.path.isdir(BIN):
    os.add_dll_directory(BIN)
    os.environ["PATH"] = BIN + os.pathsep + os.environ["PATH"]

from rtlsdr import RtlSdr  # noqa: E402  (needs the DLL path above)
import sounddevice as sd  # noqa: E402

try:
    import msvcrt
except ImportError:
    msvcrt = None

FS = 1_200_000          # IQ sample rate
AUDIO_FS = 48_000       # FS / 25
BLOCK = 128_000         # IQ samples per read (~107 ms); multiple of 256 and 25
IF_OFFSET = 250_000     # tune off to the side so the dongle's DC spike isn't on the signal
MODES = ["wfm", "nfm", "am", "usb", "lsb"]
STEPS = [100, 1e3, 5e3, 10e3, 12.5e3, 25e3, 100e3, 1e6]
MIN_FREQ, MAX_FREQ = 500e3, 1766e6

PRESETS = [
    ("FM broadcast", "88 - 108 MHz", "wfm", "python sdr.py 101.1M"),
    ("Airband (pilots, towers)", "118 - 137 MHz", "am",
     "bursty; find active channels with: python sdr.py scan 118M 137M --time 60"),
    ("NOAA weather radio (US/Canada)", "162.400 - 162.550 MHz", "nfm",
     "always on; try 162.400, .425, .450, .475, .500, .525, .550"),
    ("Marine VHF channel 16", "156.800 MHz", "nfm", "near coasts/big lakes"),
    ("Railroad (US)", "160.2 - 161.6 MHz", "nfm", "python sdr.py scan 160M 162M"),
    ("2 m ham calling (Americas)", "146.520 MHz", "nfm", "also try local repeaters 145-148 MHz"),
    ("FRS/GMRS walkie-talkies (US)", "462.5625 - 467.7125 MHz", "nfm", ""),
    ("PMR446 walkie-talkies (Europe)", "446.0 - 446.2 MHz", "nfm", ""),
    ("AM broadcast", "0.53 - 1.7 MHz", "am", "needs a long wire antenna"),
    ("Shortwave broadcast", "5.9 - 17.9 MHz", "am", "long wire antenna; best evenings/night"),
    ("40 m ham band", "7.125 - 7.300 MHz", "lsb", "long wire antenna; evenings"),
    ("20 m ham band", "14.150 - 14.350 MHz", "usb", "long wire antenna; daytime"),
]


# ---------------------------------------------------------------- helpers

def parse_freq(text):
    """'118.1M', '162.55MHz', '7200k', '101.1' (bare numbers under 3000 are MHz)."""
    m = re.fullmatch(r"\s*([\d.]+)\s*([kKmMgG]?)(?:[hH][zZ])?\s*", text)
    if not m:
        raise ValueError(f"can't read frequency {text!r}")
    value, unit = float(m.group(1)), m.group(2).lower()
    if unit:
        return value * {"k": 1e3, "m": 1e6, "g": 1e9}[unit]
    return value * 1e6 if value < 3000 else value


def fmt_freq(f):
    return f"{f / 1e6:.4f} MHz"


def guess_mode(f):
    mhz = f / 1e6
    if 87.5 <= mhz <= 108:
        return "wfm"
    if mhz < 30 or 108 < mhz < 137:
        return "am"
    return "nfm"


def default_step(mode, f):
    if mode == "wfm":
        return 100e3
    if mode in ("usb", "lsb"):
        return 1e3
    if mode == "am":
        return 5e3 if f < 30e6 else 25e3
    return 12.5e3


def power_db(x):
    return 10 * np.log10(np.mean(np.abs(x) ** 2) + 1e-12)


# ---------------------------------------------------------------- DSP blocks (all keep state between blocks)

class Mixer:
    def __init__(self, fs, shift):
        self.w = 2 * np.pi * shift / fs
        self.phase = 0.0

    def __call__(self, x):
        n = np.arange(len(x))
        out = x * np.exp(1j * (self.phase + self.w * n)).astype(np.complex64)
        self.phase = (self.phase + self.w * len(x)) % (2 * np.pi)
        return out


class Decimator:
    """FIR low-pass, then keep every `factor`-th sample."""

    def __init__(self, fs, factor, cutoff, numtaps):
        self.m = factor
        self.h = signal.firwin(numtaps, cutoff, fs=fs).astype(np.float32)
        self.tail = None
        self.phase = 0

    def __call__(self, x):
        if self.tail is None:
            self.tail = np.zeros(len(self.h) - 1, dtype=x.dtype)
        buf = np.concatenate([self.tail, x])
        self.tail = buf[len(buf) - (len(self.h) - 1):]
        y = signal.oaconvolve(buf, self.h, mode="valid")
        out = y[self.phase::self.m]
        self.phase = (self.phase - len(x)) % self.m
        return out


class IIR:
    def __init__(self, b, a):
        self.b, self.a = b, a
        self.zi = np.zeros(max(len(a), len(b)) - 1)

    def __call__(self, x):
        y, self.zi = signal.lfilter(self.b, self.a, x, zi=self.zi)
        return y


class FMDemod:
    def __init__(self):
        self.last = np.complex64(0)

    def __call__(self, x):
        prev = np.concatenate([[self.last], x[:-1]])
        self.last = x[-1]
        return np.angle(x * np.conj(prev))


class AGC:
    """Keeps AM/SSB audio at a steady level: drops fast, recovers slowly."""

    def __init__(self, target=0.3, max_gain=3e4):
        self.target, self.max_gain, self.g = target, max_gain, 1.0

    def __call__(self, x):
        want = min(self.target / (np.max(np.abs(x)) + 1e-12), self.max_gain)
        if want < self.g:
            self.g = want
            return x * want
        new = self.g + (want - self.g) * 0.05
        ramp = np.linspace(self.g, new, len(x))
        self.g = new
        return x * ramp


class Demodulator:
    """IQ block at FS in -> (audio at AUDIO_FS, channel power in dB) out."""

    def __init__(self, mode, deemph_us=75):
        self.mode = mode
        self.mix = Mixer(FS, -IF_OFFSET)
        if mode == "wfm":
            self.dec1 = Decimator(FS, 5, 110e3, 64)                 # -> 240 kHz
            self.fm = FMDemod()
            a = np.exp(-1 / (240e3 * deemph_us * 1e-6))
            self.deemph = IIR([1 - a], [1, -a])
            self.dec2 = Decimator(240e3, 5, 15e3, 64)               # -> 48 kHz audio
            return
        half_bw = {"nfm": 6e3, "am": 5e3, "usb": 3e3, "lsb": 3e3}[mode]
        self.dec1 = Decimator(FS, 5, 30e3, 24)                      # -> 240 kHz
        self.dec2 = Decimator(240e3, 5, half_bw, 128)               # -> 48 kHz channel
        if mode == "nfm":
            self.fm = FMDemod()
            b, a = signal.butter(2, [300, 3500], "bandpass", fs=AUDIO_FS)  # also drops CTCSS tones
            self.post = IIR(b, a)
        elif mode == "am":
            b, a = signal.butter(2, [60, 4500], "bandpass", fs=AUDIO_FS)
            self.post = IIR(b, a)
            self.agc = AGC()
        else:
            sign = 1 if mode == "usb" else -1
            self.down = Mixer(AUDIO_FS, -sign * 1500)               # put the 150-2850 Hz sideband
            self.sideband = Decimator(AUDIO_FS, 1, 1350, 255)       # around 0 Hz, filter it,
            self.up = Mixer(AUDIO_FS, sign * 1500)                  # and move it back
            self.agc = AGC()

    def __call__(self, iq):
        x = self.dec1(self.mix(iq))
        if self.mode == "wfm":
            p = power_db(x)
            return self.dec2(self.deemph(self.fm(x))) * 0.6, p
        x = self.dec2(x)
        p = power_db(x)
        if self.mode == "nfm":
            return self.post(self.fm(x)) * 1.2, p
        if self.mode == "am":
            return self.agc(self.post(np.abs(x))), p
        return self.agc(self.up(self.sideband(self.down(x))).real), p


# ---------------------------------------------------------------- hardware

def open_sdr(fs, gain, ppm):
    try:
        sdr = RtlSdr()
    except Exception as e:
        sys.exit(f"Could not open the RTL-SDR ({e}).\n"
                 "Is it plugged in, and closed in other programs (SDR#, SDR++, rtl_tcp)?")
    sdr.sample_rate = fs
    if ppm:
        sdr.freq_correction = ppm
    sdr.gain = gain
    return sdr


def parse_gain(text):
    return "auto" if str(text).lower() == "auto" else float(text)


def check_freq(f):
    if not MIN_FREQ <= f <= MAX_FREQ:
        raise ValueError(f"{fmt_freq(f)} is outside the V4's range (0.5 - 1766 MHz)")


# ---------------------------------------------------------------- listening

def read_keys():
    if msvcrt is None:
        return []
    keys = []
    while msvcrt.kbhit():
        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):
            ch = {"H": "UP", "P": "DOWN", "K": "LEFT", "M": "RIGHT"}.get(msvcrt.getwch(), "")
        keys.append(ch)
    return keys


def listen(args):
    freq = parse_freq(args.freq)
    check_freq(freq)
    mode = args.mode or guess_mode(freq)
    step = default_step(mode, freq)
    gain = parse_gain(args.gain or (10 if freq < 30e6 else 40))
    squelch = args.squelch
    volume = args.volume

    sdr = open_sdr(FS, gain, args.ppm)
    gains = sorted(getattr(sdr, "valid_gains_db", None) or [g / 10 for g in sdr.get_gains()])
    sdr.center_freq = freq - IF_OFFSET
    demod = Demodulator(mode, args.deemph)

    blocks = queue.Queue(maxsize=30)

    def on_samples(samples, _ctx):
        try:
            blocks.put_nowait((samples.astype(np.complex64)))
        except queue.Full:
            pass

    reader = threading.Thread(target=sdr.read_samples_async, args=(on_samples, BLOCK), daemon=True)
    reader.start()

    stream = sd.OutputStream(samplerate=AUDIO_FS, channels=1, dtype="float32", latency="high")
    stream.start()
    wav = None
    if args.record:
        wav = wave.open(args.record, "wb")
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(AUDIO_FS)

    print(__doc__.split("While listening:")[1].rstrip() if msvcrt else "")
    print()
    entry = None        # text being typed after pressing f
    noise = None        # recent channel power, for auto-squelch
    stop_at = time.time() + args.seconds if args.seconds else None
    try:
        while stop_at is None or time.time() < stop_at:
            try:
                iq = blocks.get(timeout=2)
            except queue.Empty:
                sys.stdout.write("\rNo samples from the dongle...".ljust(60))
                sys.stdout.flush()
                continue
            while blocks.qsize() > 4:      # fell behind: skip ahead
                iq = blocks.get_nowait()

            clipping = np.mean(np.abs(iq.real) > 0.98) > 0.001
            audio, level = demod(iq)
            noise = level if noise is None else 0.9 * noise + 0.1 * level
            if squelch is not None and level < squelch:
                audio = np.zeros_like(audio)
            out = np.clip(audio * volume, -1, 1).astype(np.float32)
            stream.write(out.reshape(-1, 1))
            if wav:
                wav.writeframes((out * 32767).astype(np.int16).tobytes())

            # keyboard
            new_freq, new_mode = freq, mode
            for k in read_keys():
                if entry is not None:
                    if k == "\r":
                        try:
                            f = parse_freq(entry)
                            check_freq(f)
                            new_freq = f
                            if args.mode is None:
                                new_mode = guess_mode(f)
                        except ValueError as e:
                            sys.stdout.write(f"\r{e}".ljust(80) + "\n")
                        entry = None
                    elif k == "\x1b":
                        entry = None
                    elif k == "\x08":
                        entry = entry[:-1]
                    elif len(k) == 1 and k.isprintable():
                        entry += k
                    continue
                if k in ("q", "Q", "\x1b", "\x03"):
                    raise KeyboardInterrupt
                elif k == "f":
                    entry = ""
                elif k == "RIGHT":
                    new_freq = min(MAX_FREQ, round(freq / step) * step + step)
                elif k == "LEFT":
                    new_freq = max(MIN_FREQ, round(freq / step) * step - step)
                elif k in ("UP", "DOWN"):
                    i = min(range(len(STEPS)), key=lambda j: abs(STEPS[j] - step))
                    step = STEPS[min(i + 1, len(STEPS) - 1)] if k == "UP" else STEPS[max(i - 1, 0)]
                elif k == "m":
                    new_mode = MODES[(MODES.index(mode) + 1) % len(MODES)]
                elif k in ("g", "G"):
                    cur = gains[0] if gain == "auto" else gain
                    i = min(range(len(gains)), key=lambda j: abs(gains[j] - cur))
                    gain = gains[min(i + 1, len(gains) - 1)] if k == "G" else gains[max(i - 1, 0)]
                    sdr.gain = gain
                elif k == "s":
                    squelch = None if squelch is None or squelch <= -100 else squelch - 2
                elif k == "S":
                    squelch = round(noise) if squelch is None else squelch + 2
                elif k == "a":
                    squelch = round(noise + 4)
                elif k in ("+", "="):
                    volume = min(volume * 1.25, 20)
                elif k in ("-", "_"):
                    volume = max(volume / 1.25, 0.05)
            if new_freq != freq:
                freq = new_freq
                sdr.center_freq = freq - IF_OFFSET
            if new_mode != mode:
                mode = new_mode
                step = default_step(mode, freq)
                demod = Demodulator(mode, args.deemph)

            # status line
            width = shutil.get_terminal_size((100, 20)).columns - 1
            if entry is not None:
                line = f"Frequency (e.g. 118.1M, 162.55, 7.2M), Enter to tune, Esc to cancel: {entry}_"
            else:
                bars = int(np.clip((level + 80) / 70 * 20, 0, 20))
                sq = "off" if squelch is None else f"{squelch:.0f}"
                g = "auto" if gain == "auto" else f"{gain:.1f}"
                line = (f"{fmt_freq(freq)} {mode.upper():3} step {step / 1e3:g}k  gain {g}  "
                        f"sq {sq}  vol {volume:.1f}  sig {level:6.1f} dB [{'#' * bars:20}]"
                        + ("  CLIPPING-lower gain" if clipping else "")
                        + ("  (muted)" if squelch is not None and level < squelch else ""))
            sys.stdout.write("\r" + line[:width].ljust(width))
            sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    finally:
        print()
        sdr.cancel_read_async()
        reader.join(timeout=2)
        sdr.close()
        stream.stop()
        stream.close()
        if wav:
            wav.close()


# ---------------------------------------------------------------- scanning

def scan(args):
    start, stop = sorted((parse_freq(args.start), parse_freq(args.stop)))
    check_freq(start)
    check_freq(stop)
    fs, usable, nfft, navg = 2.4e6, 2.0e6, 4096, 32
    bin_hz = fs / nfft
    rel = np.fft.fftshift(np.fft.fftfreq(nfft, 1 / fs))
    keep = np.abs(rel) < usable / 2
    centers = np.arange(start + usable / 2, stop + usable / 2, usable)
    freqs = np.concatenate([c + rel[keep] for c in centers])
    in_range = (freqs >= start) & (freqs <= stop)
    window = signal.get_window("hann", nfft)
    dc = np.abs(rel[keep]) < 3 * bin_hz

    sdr = open_sdr(fs, parse_gain(args.gain or (10 if stop < 30e6 else 40)), args.ppm)
    maxhold, hits, sweeps = None, None, 0
    end = time.time() + args.time
    print(f"Scanning {fmt_freq(start)} - {fmt_freq(stop)} for {args.time:g} s "
          f"(bursty signals like airband need longer; try --time 120). Ctrl+C to stop early.")
    try:
        while sweeps == 0 or time.time() < end:
            rows = []
            for c in centers:
                sdr.center_freq = c
                sdr.read_samples(32768)                      # let the tuner settle
                x = sdr.read_samples(nfft * navg)
                x = (x - x.mean()).reshape(navg, nfft) * window
                p = np.mean(np.abs(np.fft.fftshift(np.fft.fft(x, axis=1), axes=1)) ** 2, axis=0)
                row = 10 * np.log10(p[keep] + 1e-20)
                row[dc] = np.median(row)                    # hide the DC spike
                rows.append(row)
            spec = np.concatenate(rows)
            floor = np.median(spec[in_range])
            active = spec > floor + args.threshold
            maxhold = spec if maxhold is None else np.maximum(maxhold, spec)
            hits = active.astype(int) if hits is None else hits + active
            sweeps += 1
            sys.stdout.write(f"\r  sweep {sweeps}, {max(0, end - time.time()):.0f} s left   ")
            sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    finally:
        sdr.close()
    print()

    floor = np.median(maxhold[in_range])
    peaks, _ = signal.find_peaks(np.where(in_range, maxhold, floor),
                                 height=floor + args.threshold,
                                 distance=max(1, int(10e3 / bin_hz)), prominence=6)
    if len(peaks) == 0:
        print(f"Nothing rose {args.threshold:g} dB above the noise. "
              "Try more --time, more --gain, or a better antenna position.")
        return
    peaks = sorted(peaks, key=lambda i: -maxhold[i])[:args.top]
    print(f"\n{'frequency':>14}  {'above noise':>11}  {'on air':>8}  mode  listen with")
    for i in sorted(peaks, key=lambda i: freqs[i]):
        f = round(freqs[i] / 1e3) * 1e3
        seen = hits[max(0, i - 3):i + 4].max()
        mode = guess_mode(f)
        print(f"{f / 1e6:10.3f} MHz  {maxhold[i] - floor:8.1f} dB  {seen:3d}/{sweeps:<4d}  {mode:4}  "
              f"python sdr.py {f / 1e6:.3f}M")
    print("\n'on air' = how many sweeps it was present. A signal that is always there at a\n"
          "round number (e.g. 28.8, 57.6, 115.2 MHz) may be the dongle's own interference.")


def show_list():
    print(f"{'what':32} {'where':26} {'mode':5} notes")
    for what, where, mode, note in PRESETS:
        print(f"{what:32} {where:26} {mode:5} {note}")
    print("\nIf a channel sounds like harsh buzzing/warbling instead of a voice, it's digital\n"
          "(DMR, P25, etc.) and needs a decoder program; this script only does analog audio.")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "list":
        return show_list()

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--gain", help="tuner gain in dB, or 'auto' (default 40, or 10 below 30 MHz)")
    common.add_argument("--ppm", type=int, default=0, help="frequency correction")

    if len(sys.argv) > 1 and sys.argv[1] == "scan":
        p = argparse.ArgumentParser(prog="sdr.py scan", parents=[common],
                                    description="Sweep a frequency range and list active signals.")
        p.add_argument("start")
        p.add_argument("stop")
        p.add_argument("--time", type=float, default=20, help="seconds to keep sweeping (default 20)")
        p.add_argument("--threshold", type=float, default=10, help="dB above noise to count (default 10)")
        p.add_argument("--top", type=int, default=30, help="how many signals to list")
        return scan(p.parse_args(sys.argv[2:]))

    p = argparse.ArgumentParser(description=__doc__, parents=[common],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("freq", help="e.g. 101.1M, 118.1M, 162.55M, 7.2M")
    p.add_argument("--mode", choices=MODES, help="default: guessed from the frequency")
    p.add_argument("--squelch", type=float, help="mute below this signal level in dB (e.g. -45)")
    p.add_argument("--volume", type=float, default=1.0)
    p.add_argument("--deemph", type=float, default=75,
                   help="WFM de-emphasis in us: 75 (Americas, Korea) or 50 (elsewhere)")
    p.add_argument("--record", metavar="FILE.wav", help="also save the audio to a WAV file")
    p.add_argument("--seconds", type=float, help="stop after this many seconds")
    listen(p.parse_args())


if __name__ == "__main__":
    main()
