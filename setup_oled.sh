#!/bin/bash
# =============================================================================
# setup_oled.sh — EVO OLED display setup for NanoPi NEO
# Volumio 3 / Nikkov image / kernel 5.10.60-sunxi
#
# Run AFTER installing audiophonics_evo_sabre plugin from Volumio UI
# Usage: sudo bash setup_oled.sh
# =============================================================================

set -e

REPO="https://raw.githubusercontent.com/dtektoni-bit/EVO-Oled-on-NanoPi-NEO/main"
PLUGIN_DIR="/data/plugins/system_hardware/audiophonics_evo_sabre/apps/evo_oled"

echo "=== EVO OLED Setup for NanoPi NEO ==="
echo ""

# --- Проверить что плагин установлен ---
if [ ! -d "$PLUGIN_DIR" ]; then
    echo "ERROR: audiophonics_evo_sabre plugin not found!"
    echo "Please install it first: Volumio UI -> Plugins -> Search -> audiophonics evo sabre"
    exit 1
fi
echo "OK: Plugin found at $PLUGIN_DIR"

# --- 1. Скопировать SPI оверлеи ---
echo ""
echo "[1/5] Copying SPI overlays..."
wget -q -O /boot/overlay-user/sun8i-h3-spi0.dts "${REPO}/overlay-user/sun8i-h3-spi0.dts" || { echo "Failed to download sun8i-h3-spi0.dts"; exit 1; }
wget -q -O /boot/overlay-user/sun8i-h3-spi0.dtbo "${REPO}/overlay-user/sun8i-h3-spi0.dtbo" || { echo "Failed to download sun8i-h3-spi0.dtbo"; exit 1; }
wget -q -O /boot/overlay-user/sun8i-h3-i2s0-slave.dts "${REPO}/overlay-user/sun8i-h3-i2s0-slave.dts" || { echo "Failed to download sun8i-h3-i2s0-slave.dts"; exit 1; }
wget -q -O /boot/overlay-user/sun8i-h3-i2s0-slave.dtbo "${REPO}/overlay-user/sun8i-h3-i2s0-slave.dtbo" || { echo "Failed to download sun8i-h3-i2s0-slave.dtbo"; exit 1; }
echo "Done."

# --- 2. Прописать user_overlays в armbianEnv.txt ---
echo ""
echo "[2/5] Updating armbianEnv.txt..."
if grep -q "user_overlays=" /boot/armbianEnv.txt; then
    if ! grep -q "sun8i-h3-i2s0-slave" /boot/armbianEnv.txt; then
        sed -i 's/user_overlays=\(.*\)/user_overlays=sun8i-h3-i2s0-slave sun8i-h3-spi0 \1/' /boot/armbianEnv.txt
        echo "Added overlays to existing user_overlays line."
    else
        echo "Overlays already present, skipping."
    fi
else
    echo "user_overlays=sun8i-h3-i2s0-slave sun8i-h3-spi0" >> /boot/armbianEnv.txt
    echo "Added user_overlays line."
fi

# --- 3. Закомментировать конфликтующий dtoverlay=gpio-ir ---
echo ""
echo "[3/5] Disabling conflicting dtoverlay in userconfig.txt..."
if [ -f /boot/userconfig.txt ]; then
    sed -i 's/^dtoverlay=gpio-ir/#dtoverlay=gpio-ir/' /boot/userconfig.txt
    echo "Done."
else
    echo "userconfig.txt not found, skipping."
fi

# --- 4. Скопировать кастомные файлы плагина ---
echo ""
echo "[4/5] Installing custom plugin files..."
wget -q -O "$PLUGIN_DIR/gpiomap.js" "${REPO}/evo_oled/gpiomap.js" || { echo "Failed to download gpiomap.js"; exit 1; }
wget -q -O "$PLUGIN_DIR/index.js" "${REPO}/evo_oled/index.js" || { echo "Failed to download index.js"; exit 1; }
wget -q -O "$PLUGIN_DIR/volumiolistener.js" "${REPO}/evo_oled/volumiolistener.js" || { echo "Failed to download volumiolistener.js"; exit 1; }
echo "Done."

# --- 5. Перезагрузка ---
echo ""
echo "[5/5] Setup complete."
echo ""
echo "============================================"
echo "  REBOOT REQUIRED to activate SPI display  "
echo "  sudo reboot                               "
echo "============================================"
