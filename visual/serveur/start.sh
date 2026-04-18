#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${FOGGY_VISUAL_PORT:-4173}"

echo "Foggy Visual serveur sur http://127.0.0.1:${PORT}/"
FOGGY_VISUAL_PORT="${PORT}" python3 "${SCRIPT_DIR}/server.py"
