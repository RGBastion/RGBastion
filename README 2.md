# RedGalaxy Mac Runner

This workspace contains a small macOS runner for `~/Desktop/RedGalaxy-Setup.exe`.

## What it does

- Checks the installer, macOS version, CPU, Rosetta, Homebrew, and available Windows runners.
- Uses a command-line Wine backend when one is available (`wine`, `wine64`, or CrossOver's bundled Wine).
- Can download a local Wine Stable runtime into `./runtimes` and use it without installing Wine globally.
- Creates a dedicated Wine prefix at `~/Library/Application Support/RedGalaxy Mac Runner/prefix`.
- Runs the RedGalaxy Windows installer and stores logs in `~/Library/Logs/RedGalaxy Mac Runner`.
- Tries to detect the installed game executable and creates `Launch RedGalaxy.command`.
- Falls back to `Sikarugir Creator.app`/Wineskin when no command-line Wine backend exists.

## Quick start

Run a diagnosis:

```bash
./bin/redgalaxy-mac-runner doctor
```

Install missing helper app/runtime fallback:

```bash
./bin/redgalaxy-mac-runner install-deps
```

Install only the local Wine runtime:

```bash
./bin/redgalaxy-mac-runner install-local-wine
```

Run the installer and test the installed game:

```bash
./bin/redgalaxy-mac-runner install-and-test --silent --safe-webview
```

You can also double-click `RedGalaxy Runner.app` in this folder. It opens Terminal and runs `launch --safe-webview` against the installed client.

After installation, launch the installed client:

```bash
./bin/redgalaxy-mac-runner launch --safe-webview
```

Or use:

```bash
~/Library/Application\ Support/RedGalaxy\ Mac\ Runner/Launch\ RedGalaxy.command
```

## Current test result

The installer completed successfully and installed:

```text
~/Library/Application Support/RedGalaxy Mac Runner/prefix/drive_c/users/andersonguillin/AppData/Local/RedGalaxy/redgalaxy-client.exe
```

On this Mac, the free local Wine 11.0 runtime starts the Tauri/WebView2 client but then WebView2 crashes with a Wine page fault after initializing MoltenVK/Vulkan. The runner includes a `--safe-webview` mode that disables GPU/Vulkan/WebGPU flags where WebView2 honors them, but this RedGalaxy build still crashes under Wine 11.0.

## Notes

`RedGalaxy-Setup.exe` is a 32-bit Windows NSIS installer that installs a 64-bit Tauri/WebView2 client. On Apple Silicon Macs that requires Rosetta and a Wine-compatible runtime with working WebView2 support. The runner first tries a command-line Wine backend, including the local `./runtimes/Wine Stable.app` runtime. CrossOver is likely the next backend to try because it carries additional Wine patches; Sikarugir Creator is a free Wineskin-style fallback but did not expose a usable command-line runtime in this environment.
