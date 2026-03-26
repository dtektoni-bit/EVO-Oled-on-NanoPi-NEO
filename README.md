# EVO OLED Display on NanoPi NEO

Setup script for Audiophonics EVO SABRE OLED display (SSD1322 256×64) on NanoPi NEO running Volumio 3 (Nikkov image, kernel 5.10.60-sunxi).

## What this does

- Copies SPI device tree overlays to `/boot/overlay-user/`
- Activates overlays in `armbianEnv.txt`
- Disables conflicting `dtoverlay=gpio-ir` in `userconfig.txt`
- Replaces plugin files with NanoPi NEO compatible versions:
  - `gpiomap.js` — hardcoded GPIO mapping (fixes NOPERM error)
  - `index.js` — custom display layout
  - `volumiolistener.js` — Spotify seek fix

## Hardware

| Display pin | NanoPi NEO GPIO1 pin       | Description   |
|-------------|----------------------------|---------------|
| VCC         | Pin 1 (3.3V)               | Power         |
| GND         | Pin 6 (GND)                | Ground        |
| CLK         | Pin 23 (SPI0_CLK)          | SPI clock     |
| MOSI        | Pin 19 (SPI0_MOSI)         | SPI data      |
| CS          | Pin 24 (SPI0_CS)           | Chip select   |
| DC          | Pin 22 (PA1)               | Data/Command  |
| RST         | 3.3V via RC (10kΩ + 100nF) | Reset         |

## Installation

### Step 1 — Install audiophonics plugin from Volumio UI

Volumio UI → Plugins → Search → **audiophonics evo sabre** → Install

### Step 2 — Run setup script

```bash
git clone https://github.com/dtektoni-bit/EVO-Oled-on-NanoPi-NEO
cd EVO-Oled-on-NanoPi-NEO
sudo bash setup_oled.sh
```

### Step 3 — Reboot

```bash
sudo reboot
```

### Step 4 — Enable plugin

Volumio UI → Plugins → My Plugins → audiophonics evo sabre → Enable

## Display layout

**Playback mode**
```
[▶/⏸/■]  NETWORK [center]  [repeat]
←←← track title scrolling ←←←
————————— seekbar —————————
1:24 [left]          -0:42 [right]
     44.1KHz : 16bit [center]
          DF:Sharp [center]
```

**Clock mode (idle)**
```
NETWORK [center]      2026/03/10
        14:11:26
————————————————————————————————
10.0.0.43              DF:Sharp
```

**SPDIF mode**
```
SPDIF [center]        2026/03/10
        14:11:26
————————————————————————————————
10.0.0.43              DF:Sharp
```

## Troubleshooting

| Symptom | Cause | Solution |
|---------|-------|----------|
| `/dev/spidev0.0` missing | Overlays not loaded | Check `armbianEnv.txt`, reboot |
| Plugin crashes 77/NOPERM | `gpiomap.js` not replaced | Re-run `setup_oled.sh` |
| Screen shows nothing | DC pin wiring or plugin not enabled | Check pin 22 (PA1) connection |
| Screen goes to clock during Spotify | seek not updated | Fixed in `volumiolistener.js` |

## Notes

- `sun8i-h3-i2s0-slave.dtbo` is **modified** — `spi0_cs_pins` block removed to free SPI0_CS pin (PC3)
- `overlays=` does not work on this u-boot — only `user_overlays=` works
- After plugin update — re-run `setup_oled.sh` to restore custom files
