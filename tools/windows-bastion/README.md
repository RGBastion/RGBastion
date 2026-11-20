# Bastion — Windows (Electron)

Electron host for **RedGalaxy Bastion** (macOS Bastion parity):

1. Serves `artifacts/redgalaxy-story-web-redgalaxy` over `http://127.0.0.1:8765/`
2. Opens a native window titled `RedGalaxy Bastion`
3. Includes story hooks (`__RG_STORY_MODE__`, `i18n.js`, `autopilot.js`)
4. Keeps license product id `redgalaxy-story`
5. Can update official game web assets into `%APPDATA%/redgalaxy-bastion/game-web/web` (Node extract/patch)

RedUniverse Bastion is not part of this workflow.

## Portable cold start

Stock electron-builder portable SFX **re-extracts and deletes ~500MB on every launch**.
This repo ships a custom `portable.nsi` that extracts once into
`%LOCALAPPDATA%\RedGalaxyBastionPortable` and reuses it
when `.bastion-portable-version` matches the app version. First launch is still heavy;
later launches should be close to the zip/unpacked app.

## Prefer the repo build scripts

```bash
# RedGalaxy Bastion only (zip + portable) — default
./tools/build_redgalaxy_bastion_exe.sh

# Explicit brand (only redgalaxy is accepted)
BASTION_BRAND=redgalaxy ./tools/build_redgalaxy_bastion_exe.sh
```

Artifacts land in `dist/` and `dist/windows-bastion/` as `RedGalaxy-Bastion.*`.
