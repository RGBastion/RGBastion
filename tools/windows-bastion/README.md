# RedGalaxy Bastion — Windows (Electron)

Electron host that mirrors the macOS Bastion app:

1. Serves `artifacts/redgalaxy-story-web` over `http://127.0.0.1:8765/` (or the next free port)
2. Opens a native window titled **RedGalaxy Bastion**
3. Includes the same story hooks (`__RG_STORY_MODE__`, `i18n.js`, `autopilot.js`)
4. Keeps license product id `redgalaxy-story`
5. Can update official game web assets into `%APPDATA%/redgalaxy-bastion/game-web/web` (Node extract/patch — no Python required)

## In-app game updates

On launch (or Security tab → **Update game**), Bastion checks `https://updates.redgalaxygame.space/latest.json`, downloads the official Windows installer (if needed), extracts web assets from `redgalaxy-client.exe` with the bundled Node scripts, then re-applies Bastion story patches.

Python is no longer required for updates. The updater prefers `extract_redgalaxy_web.js` + `apply_bastion_patches.js` (Electron's Node + built-in brotli). A real system Python (`py -3` / python.org install) is only used as a fallback if the Node scripts are missing from the package.

If update fails, the bundled `resources/web` is used.

## Prefer the repo build scripts

From the repo root:

```bash
# macOS / Linux — zip + portable .exe (electron-builder scarica Wine interno se serve)
./tools/build_redgalaxy_bastion_exe.sh

# Solo zip, o solo portable, o tutto:
./tools/build_redgalaxy_bastion_exe.sh zip
./tools/build_redgalaxy_bastion_exe.sh portable
./tools/build_redgalaxy_bastion_exe.sh all

# Windows PowerShell
.\tools\build_redgalaxy_bastion_exe.ps1
```

Artifacts land in `dist/` and `dist/windows-bastion/`.

## Manual npm flow

```bash
./tools/prepare_redgalaxy_story_web.sh
cd tools/windows-bastion
npm install
npm start                 # dev window (requires prepared web assets)
npm run pack:zip          # works on macOS without Wine → dist/windows-bastion/*.zip
npm run pack:portable     # single .exe (best on Windows; on macOS needs Wine)
npm run pack:nsis         # installer (Windows or Wine)
```

Artifacts land in `dist/windows-bastion/`.

## Run without packaging

```bash
./tools/prepare_redgalaxy_story_web.sh
cd tools/windows-bastion && npm install && npm start
```
