# Foggy

Foggy is an Android exploration app where the map starts hidden and is revealed as you move.

## Features

- Real-time map with `osmdroid`
- Fog-of-war reveal based on GPS tracking
- Three fog views: normal, black, and status
- Manual cell editing: add, delete, bulk add, bulk delete
- Local SQLite storage for discovered cells
- Current city detection and discovered area percentage

## Run

```bash
./gradlew installDebug
adb shell am start -n com.example.foggy/.MainActivity
```

For an emulator:

```bash
emulator -list-avds
emulator -avd YOUR_AVD_NAME
adb emu geo fix 4.8405 45.7340
```

## Notes

- Location data is stored locally on the device.
- The app uses foreground/background location permissions for tracking.
- This project is still a prototype.
