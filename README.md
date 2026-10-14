# opal-sdr-project

Small tools for an **RTL-SDR Blog V4** dongle on Windows:

| Tool | What it does |
|------|--------------|
| `sdr.py` | Radio receiver for the terminal. Plays WFM, NFM, AM, USB and LSB live, scans a band for active signals, and records audio to WAV. |
| `adsb.py` | Live terminal table of aircraft heard on 1090 MHz (ADS-B / Mode S): call sign, altitude, speed, heading, position and distance. |
| `adsb-map/` | Node.js web map of **aircraft** (ADS-B, 1090 MHz) and **ships** (AIS, 162 MHz), streamed to the browser, with Bangkok and eastern Thailand base maps. |

## Hardware

- RTL-SDR Blog V4 (other RTL2832U dongles should work too)
- A suitable antenna: about 6.9 cm per arm for 1090 MHz ADS-B, about 46 cm per arm for 162 MHz AIS, and a long wire for HF/shortwave
- Results are best with the antenna high up or at a window

## Setup

### 1. Driver binaries (`bin/`)

The `bin/` folder is **not in this repo**. Third-party executables and DLLs are kept out of git. Create it next to the scripts and fill it in:

```
bin/
├── rtlsdr.dll, libusb-1.0.dll, pthreadVC2.dll, msvcr100.dll   # RTL-SDR Blog V4 drivers
├── rtl_adsb.exe, rtl_fm.exe, rtl_test.exe, ...                # rtl-sdr tools
├── ais-catcher/AIS-catcher.exe (+ its DLLs)                   # for ships on the map
└── rtl_433/                                                   # optional
```

- RTL-SDR Blog V4 drivers and tools: https://github.com/rtlsdrblog/rtl-sdr-blog/releases (Windows release zip)
- AIS-catcher: https://github.com/jvde-github/AIS-catcher/releases
- rtl_433 (optional): https://github.com/merbanan/rtl_433/releases

You also need to install the WinUSB driver for the dongle with [Zadig](https://zadig.akeo.ie/).

### 2. Python tools

Python 3.8 or newer is needed.

```sh
pip install -r requirements.txt
```

### 3. Map (Node.js 18.3+)

The map has no npm dependencies.

```sh
cd adsb-map
npm start
```

## Usage

### `sdr.py`: listen and scan

```sh
python sdr.py 101.1M                 # listen (mode is guessed from the frequency)
python sdr.py 118.1M --mode am       # choose the mode: wfm nfm am usb lsb
python sdr.py 162.55M --squelch -45  # mute noise until a signal appears
python sdr.py 145.675M --record out.wav --seconds 60
python sdr.py scan 118M 137M         # sweep a range and list active frequencies
python sdr.py list                   # presets worth trying
```

Keys while listening:

| Key | Action |
|-----|--------|
| ← / → | tune down / up one step |
| ↑ / ↓ | larger / smaller step |
| `f` | type a new frequency |
| `m` | change mode |
| `g` / `G` | gain down / up |
| `s` / `S` | squelch down / up |
| `a` | auto-squelch (just above the current noise) |
| `-` / `+` | volume |
| `q` / Esc | quit |

Common options: `--gain <dB|auto>`, `--ppm <n>`.

### `adsb.py`: aircraft in the terminal

```sh
python adsb.py                          # live table of aircraft
python adsb.py --lat 13.75 --lon 100.50 # also show distance from you (faster position fixes)
python adsb.py --log raw.txt            # also save raw messages
python adsb.py --replay raw.txt         # decode a saved log instead of the radio
```

`bin/rtl_adsb.exe` demodulates the raw Mode S frames, and [pyModeS](https://github.com/junzis/pyModeS) decodes them.

### `adsb-map/`: planes and ships in the browser

```sh
cd adsb-map
npm start                                # planes (switch to ships/both on the page)
npm start -- --mode both                 # planes + ships; one dongle takes turns
node server.js --lat 13.75 --lon 100.50  # your location
node server.js --log raw.txt             # save raw messages
node server.js --replay raw.txt          # play back a saved log
npm run demo                             # fake planes and ships, no dongle needed
npm test                                 # run decoder/tracker tests
```

The page opens at http://localhost:8765. With two dongles plugged in, planes use device 0 and ships use device 1 (`--planes-device`, `--ships-device`). With one dongle, the server switches between planes and ships every 40 s (`--planes-time`, `--ships-time`).

Only one program can use the dongle at a time. Close `sdr.py`, `adsb.py` or SDR++ before starting the map.

## Project layout

```
sdr.py              terminal receiver / scanner
adsb.py             terminal ADS-B table
requirements.txt    Python dependencies
adsb-map/
  server.js         runs rtl_adsb + AIS-catcher, serves the map, streams updates
  decoder.js        Mode S / ADS-B decoding
  tracker.js        aircraft state
  ships.js          AIS vessel state
  public/           browser map (HTML/CSS/JS, base map vector data)
  test/             node:test unit tests
```

## Notes

- Laws on radio reception vary by country. Check what is allowed where you are, and do not rely on these tools for navigation or safety.
- Bundled third-party tools (rtl-sdr, AIS-catcher, rtl_433) have their own licenses (mostly GPL).
