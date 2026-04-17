#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="com.example.foggy"
DATABASE_NAME="location_history.db"
DATABASE_DIR="/data/data/${PACKAGE_NAME}/databases"
DATABASE_PATH="${DATABASE_DIR}/${DATABASE_NAME}"

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 path/to/database.db" >&2
  exit 1
fi

SOURCE_DB="$1"

if [ ! -f "$SOURCE_DB" ]; then
  echo "Error: file not found: $SOURCE_DB" >&2
  exit 1
fi

case "$SOURCE_DB" in
  *.db) ;;
  *)
    echo "Error: source file must have a .db extension" >&2
    exit 1
    ;;
esac

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Error: sqlite3 is required to validate the database" >&2
  exit 1
fi

INTEGRITY_RESULT="$(sqlite3 "$SOURCE_DB" "PRAGMA integrity_check;")"
if [ "$INTEGRITY_RESULT" != "ok" ]; then
  echo "Error: SQLite integrity check failed:" >&2
  echo "$INTEGRITY_RESULT" >&2
  exit 1
fi

REQUIRED_COLUMNS="$(sqlite3 "$SOURCE_DB" "
  SELECT COUNT(*)
  FROM pragma_table_info('gps_points')
  WHERE name IN ('grid_column', 'grid_row', 'recorded_at', 'edit_state');
")"

if [ "$REQUIRED_COLUMNS" != "4" ]; then
  echo "Error: database is missing the expected v4 gps_points columns" >&2
  exit 1
fi

adb shell "run-as ${PACKAGE_NAME} mkdir -p '${DATABASE_DIR}'"
adb push "$SOURCE_DB" "/data/local/tmp/${DATABASE_NAME}" >/dev/null
adb shell "run-as ${PACKAGE_NAME} cp '/data/local/tmp/${DATABASE_NAME}' '${DATABASE_PATH}'"
adb shell "rm '/data/local/tmp/${DATABASE_NAME}'"

echo "Installed $SOURCE_DB into ${PACKAGE_NAME}:${DATABASE_PATH}"
