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

# --- 2. Обновить armbianEnv.txt ---
echo ""
echo "[2/5] Updating armbianEnv.txt..."

# Добавить fdtfile если нет
if ! grep -q "fdtfile=" /boot/armbianEnv.txt; then
    sed -i '/overlay_prefix=sun8i-h3/a fdtfile=sun8i-h3-nanopi-neo.dtb' /boot/armbianEnv.txt
    echo "Added fdtfile."
fi

# Добавить spi-spidev в overlays= если нет
if ! grep -q "spi-spidev" /boot/armbianEnv.txt; then
    sed -i 's/overlays=\(.*\)/overlays=\1 spi-spidev/' /boot/armbianEnv.txt
    echo "Added spi-spidev to overlays."
fi

# Добавить sun8i-h3-spi0 в user_overlays если нет
if grep -q "user_overlays=" /boot/armbianEnv.txt; then
    if ! grep -q "sun8i-h3-spi0" /boot/armbianEnv.txt; then
        sed -i 's/user_overlays=\(.*\)/user_overlays=\1 sun8i-h3-spi0/' /boot/armbianEnv.txt
        echo "Added sun8i-h3-spi0 to user_overlays."
    else
        echo "sun8i-h3-spi0 already present, skipping."
    fi
else
    echo "user_overlays=sun8i-h3-i2s0-slave sun8i-h3-spi0" >> /boot/armbianEnv.txt
    echo "Added user_overlays line."
fi
echo "Done."

# --- 3. Создать файл автозагрузки spidev ---
echo ""
echo "[3/5] Enabling spidev module..."
echo "spidev" | tee /etc/modules-load.d/spidev.conf
echo "Done."

# --- 4. Скопировать кастомные файлы плагина ---
echo ""
echo "[4/5] Installing custom plugin files..."
wget -q -O "$PLUGIN_DIR/gpiomap.js" "${REPO}/evo_oled/gpiomap.js" || { echo "Failed to download gpiomap.js"; exit 1; }
wget -q -O "$PLUGIN_DIR/index.js" "${REPO}/evo_oled/index.js" || { echo "Failed to download index.js"; exit 1; }
wget -q -O "$PLUGIN_DIR/volumiolistener.js" "${REPO}/evo_oled/volumiolistener.js" || { echo "Failed to download volumiolistener.js"; exit 1; }
echo "Done."

# --- 5. Готово ---
echo ""
echo "[5/5] Setup complete."
echo ""
echo "============================================"
echo "  REBOOT REQUIRED to activate SPI display  "
echo "  sudo reboot                               "
echo "============================================"
