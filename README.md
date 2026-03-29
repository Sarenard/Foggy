# Foggy

Foggy is a small Android exploration app built around a map covered by fog.

As you move, the app reveals the area around your current position and around saved GPS points. It also stores location points locally in a SQLite database.

## Features

- Live map using osmdroid
- Fog of war effect on top of the map
- Reveal radius around the player
- Optional reveal around saved points
- Local GPS history stored on device

## Tech Stack

- Kotlin
- Android Views
- osmdroid
- SQLite

## Run Locally

Requirements:

- Android Studio
- Android SDK
- A connected Android phone or an Android emulator

Install and run:

```bash
./gradlew installDebug
adb shell am start -n com.example.foggy/.MainActivity
```

## Run On An Emulator

List available virtual devices:

```bash
emulator -list-avds
```

Start one:

```bash
emulator -avd YOUR_AVD_NAME
```

Then install and launch the app:

```bash
./gradlew installDebug
adb shell am start -n com.example.foggy/.MainActivity
```

You can simulate a GPS position with:

```bash
adb emu geo fix 4.8405 45.7340
```

## Notes

- Local location history is stored in a device-side SQLite database and should not be committed.
- The project `.gitignore` excludes local build files and the local database.
- Background location behavior may require additional explanation and compliance work before Play Store release.

## Status

This project is currently a prototype / experimental app.
