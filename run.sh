#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APK_PATH="$PROJECT_DIR/app/build/outputs/apk/debug/app-debug.apk"
PACKAGE_NAME="com.example.foggy"
MAIN_ACTIVITY="com.example.foggy.MainActivity"
KOTLIN_BUILD_DIR="$PROJECT_DIR/app/build/kotlin"
APP_BUILD_DIR="$PROJECT_DIR/app/build"
LOG_DIR="$PROJECT_DIR/logs"
CRASH_LOG="$LOG_DIR/adb-crash.log"
RESET_APP_DATA=false

cd "$PROJECT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Erreur: commande introuvable: $1" >&2
    exit 1
  fi
}

require_cmd adb
require_cmd grep

mkdir -p "$LOG_DIR"

usage() {
  echo "Usage: ./run.sh [--reset]"
  echo "  --reset    Supprime les donnees de l'app avant installation"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)
      RESET_APP_DATA=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Erreur: option inconnue: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -x "$PROJECT_DIR/gradlew" ]]; then
  chmod +x "$PROJECT_DIR/gradlew"
fi

if [[ ! -f "$PROJECT_DIR/gradlew" ]]; then
  echo "Erreur: gradlew est introuvable dans $PROJECT_DIR" >&2
  exit 1
fi

echo "==> Compilation de l'application"
echo "==> Nettoyage des caches de build locaux"
rm -rf "$KOTLIN_BUILD_DIR" "$APP_BUILD_DIR/tmp"

echo "==> Build Gradle sans daemon"
"$PROJECT_DIR/gradlew" --no-daemon clean :app:assembleDebug

if [[ ! -f "$APK_PATH" ]]; then
  echo "Erreur: APK introuvable apres compilation: $APK_PATH" >&2
  exit 1
fi

echo "==> Verification de l'appareil ADB"
adb start-server >/dev/null

mapfile -t DEVICES < <(adb devices | awk 'NR>1 && $2 == "device" { print $1 }')

if [[ ${#DEVICES[@]} -eq 0 ]]; then
  echo "Erreur: aucun appareil ADB pret. Active le debogage USB et reconnecte ton telephone." >&2
  exit 1
fi

if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  DEVICE="$ANDROID_SERIAL"
else
  if [[ ${#DEVICES[@]} -gt 1 ]]; then
    echo "Erreur: plusieurs appareils detectes. Relance avec ANDROID_SERIAL=<serial> ./run.sh" >&2
    printf 'Appareils disponibles:\n' >&2
    printf ' - %s\n' "${DEVICES[@]}" >&2
    exit 1
  fi
  DEVICE="${DEVICES[0]}"
fi

if [[ "$RESET_APP_DATA" == true ]]; then
  echo "==> Suppression des donnees applicatives"
  adb -s "$DEVICE" shell pm clear "$PACKAGE_NAME" >/dev/null || true
else
  echo "==> Conservation des donnees applicatives"
fi

echo "==> Installation sur $DEVICE"
adb -s "$DEVICE" install -r "$APK_PATH"

echo "==> Preparation du diagnostic crash"
adb -s "$DEVICE" logcat -c

echo "==> Lancement de l'application"
adb -s "$DEVICE" shell am start -n "$PACKAGE_NAME/$MAIN_ACTIVITY"

echo "==> Capture des logs"
sleep 4
adb -s "$DEVICE" logcat -d > "$CRASH_LOG"

echo "==> Extrait utile"
if grep -E -A 40 -B 10 "FATAL EXCEPTION|AndroidRuntime|Process: $PACKAGE_NAME|$PACKAGE_NAME" "$CRASH_LOG"; then
  true
else
  echo "Aucun crash evident trouve dans $CRASH_LOG"
fi

echo "==> Log complet enregistre dans $CRASH_LOG"
echo "==> Termine"
