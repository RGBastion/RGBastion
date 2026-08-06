# Bastion — Windows (Electron)

Electron host that mirrors the macOS Bastion apps (RedGalaxy + RedUniverse):

1. Serves branded `artifacts/redgalaxy-story-web-<brand>` over `http://127.0.0.1:8765/`
2. Opens a native window titled from `package.json` productName
3. Includes story hooks (`__RG_STORY_MODE__`, `i18n.js`, `autopilot.js`)
4. Keeps license product id `redgalaxy-story`
5. Can update official game web assets into `%APPDATA%/<app>/game-web/web` (Node extract/patch)

## Portable cold start

Stock electron-builder portable SFX **re-extracts and deletes ~500MB on every launch**.
This repo ships a custom `portable.nsi` that extracts once into
`%LOCALAPPDATA%\RedGalaxyBastionPortable` / `RedUniverseBastionPortable` and reuses it
when `.bastion-portable-version` matches the app version. First launch is still heavy;
later launches should be close to the zip/unpacked app.

## Prefer the repo build scripts

```bash
# Both brands (zip + portable)
./tools/build_redgalaxy_bastion_exe.sh

# One brand
BASTION_BRAND=redgalaxy ./tools/build_redgalaxy_bastion_exe.sh
BASTION_BRAND=reduniverse ./tools/build_redgalaxy_bastion_exe.sh portable
```

Artifacts land in `dist/` and `dist/windows-bastion/`.
