#!/usr/bin/env bash
# auto_flash.sh - Automatically catches ESP32-S3 bootloader and flashes firmware
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR/.."

echo "Compiling firmware first to ensure binary is fresh..."
arduino-cli compile -b esp32:esp32:esp32s3:CDCOnBoot=cdc hardware/linea_beacon

echo ""
echo "======================================================================"
echo "READY TO FLASH ESP32-S3"
echo "======================================================================"
echo "Looking for ESP32-S3 in bootloader mode..."
echo ""

while true; do
  PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -n 1 || true)
  if [ -n "$PORT" ]; then
    echo "[$(date +%T)] Probing $PORT..."
    if /Users/pareshprabhuraj/Library/Arduino15/packages/esp32/tools/esptool_py/5.3.1/esptool --chip esp32s3 --port "$PORT" --baud 921600 --before default-reset --after hard-reset write-flash -z --flash-mode keep --flash-freq keep --flash-size keep 0x0 /Users/pareshprabhuraj/Library/Caches/arduino/sketches/FDEEB9E50691E4DF85BAEF2BFF94C095/linea_beacon.ino.bootloader.bin 0x8000 /Users/pareshprabhuraj/Library/Caches/arduino/sketches/FDEEB9E50691E4DF85BAEF2BFF94C095/linea_beacon.ino.partitions.bin 0xe000 /Users/pareshprabhuraj/Library/Arduino15/packages/esp32/hardware/esp32/3.3.12/tools/partitions/boot_app0.bin 0x10000 /Users/pareshprabhuraj/Library/Caches/arduino/sketches/FDEEB9E50691E4DF85BAEF2BFF94C095/linea_beacon.ino.bin; then
      echo ""
      echo "======================================================================"
      echo "FLASH SUCCESSFUL! ESP32-S3 FIRMWARE INSTALLED!"
      echo "======================================================================"
      exit 0
    fi
  fi
  echo "Waiting for BOOT mode... Hold BOOT, click RST once, release BOOT."
  sleep 1
done
