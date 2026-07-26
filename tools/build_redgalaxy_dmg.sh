#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
WEB_DIR="$PROJECT_DIR/artifacts/redgalaxy-native-web"
DIST_DIR="$PROJECT_DIR/dist"
BUILD_DIR="$DIST_DIR/build"
APP_DIR="$DIST_DIR/RedGalaxy Native.app"
DMG_ROOT="$DIST_DIR/dmg-root"
DMG_RW="$BUILD_DIR/RedGalaxy-Native.rw.dmg"
DMG_PATH="$DIST_DIR/RedGalaxy-Native.dmg"
SERVER_SRC="$SCRIPT_DIR/redgalaxy_native_server.c"
SERVER_BIN="$BUILD_DIR/redgalaxy-native-server"
HOST_OBJC_SRC="$SCRIPT_DIR/redgalaxy_native_host.m"
HOST_SWIFT_SRC="$SCRIPT_DIR/redgalaxy_native_host.swift"
HOST_BIN="$BUILD_DIR/redgalaxy-native-host"
ICON_ICNS="$BUILD_DIR/RedGalaxy.icns"
BG_PNG="$BUILD_DIR/dmg-background.png"
VOLUME_NAME="RedGalaxy Native"

[[ -f "$WEB_DIR/index.html" ]] || {
  echo "Missing web assets: $WEB_DIR/index.html" >&2
  exit 1
}

mkdir -p "$BUILD_DIR"

echo "Building RedGalaxy icon..."
chmod +x "$SCRIPT_DIR/make_redgalaxy_icon.sh" "$SCRIPT_DIR/make_dmg_background.sh"
"$SCRIPT_DIR/make_redgalaxy_icon.sh"
"$SCRIPT_DIR/make_dmg_background.sh"

echo "Compiling native server..."
if cc -O2 -Wall -Wextra -std=c11 -mmacosx-version-min=11.0 -arch arm64 -arch x86_64 "$SERVER_SRC" -o "$SERVER_BIN" 2>/dev/null; then
  echo "Built universal arm64/x86_64 server."
else
  cc -O2 -Wall -Wextra -std=c11 "$SERVER_SRC" -o "$SERVER_BIN"
  echo "Built native-architecture server."
fi

HOST_BUILT=0
if [[ -f "$HOST_OBJC_SRC" ]]; then
  if cc -O2 -Wall -Wextra -fobjc-arc -mmacosx-version-min=11.0 \
    -arch arm64 -arch x86_64 \
    -framework Cocoa -framework WebKit \
    "$HOST_OBJC_SRC" -o "$HOST_BIN"; then
    echo "Built universal arm64/x86_64 host."
    HOST_BUILT=1
  else
    echo "Objective-C host compilation failed; trying Swift fallback." >&2
  fi
fi

if [[ "$HOST_BUILT" == "0" ]] && command -v xcrun >/dev/null 2>&1 && [[ -f "$HOST_SWIFT_SRC" ]]; then
  if CLANG_MODULE_CACHE_PATH="$BUILD_DIR/module-cache-swift" xcrun swiftc -O \
    -framework Foundation -framework Cocoa -framework WebKit \
    -target "$(uname -m)-apple-macos11.0" \
    "$HOST_SWIFT_SRC" -o "$HOST_BIN"; then
    echo "Built native-architecture Swift host."
    HOST_BUILT=1
  else
    echo "Host wrapper compilation failed; fallback to server-only launcher." >&2
  fi
fi

rm -rf "$APP_DIR" "$DMG_ROOT" "$DMG_RW" "$DMG_PATH"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" "$DMG_ROOT/.background"

cp "$SERVER_BIN" "$APP_DIR/Contents/MacOS/redgalaxy-native-server"
chmod +x "$APP_DIR/Contents/MacOS/redgalaxy-native-server"
if [[ "$HOST_BUILT" == "1" ]]; then
  cp "$HOST_BIN" "$APP_DIR/Contents/MacOS/redgalaxy-native-host"
  chmod +x "$APP_DIR/Contents/MacOS/redgalaxy-native-host"
fi
cp -R "$WEB_DIR" "$APP_DIR/Contents/Resources/web"
cp "$ICON_ICNS" "$APP_DIR/Contents/Resources/AppIcon.icns"
cp "$PROJECT_DIR/bin/redgalaxy-mac-runner" "$APP_DIR/Contents/Resources/redgalaxy-mac-runner"
cp "$PROJECT_DIR/tools/extract_redgalaxy_web.py" "$APP_DIR/Contents/Resources/extract_redgalaxy_web.py"
chmod +x "$APP_DIR/Contents/Resources/redgalaxy-mac-runner"
chmod +x "$SCRIPT_DIR/bundle_brotli_runtime.sh"
"$SCRIPT_DIR/bundle_brotli_runtime.sh" "$APP_DIR/Contents/Resources" || true

APP_EXECUTABLE="redgalaxy-native-server"
if [[ "$HOST_BUILT" == "1" && -x "$APP_DIR/Contents/MacOS/redgalaxy-native-host" ]]; then
  APP_EXECUTABLE="redgalaxy-native-host"
fi

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>RedGalaxy Native</string>
  <key>CFBundleExecutable</key>
  <string>$APP_EXECUTABLE</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>local.redgalaxy.native</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>RedGalaxy Native</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

printf 'APPL????' > "$APP_DIR/Contents/PkgInfo"

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || true
fi

cp -R "$APP_DIR" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"
cp "$BG_PNG" "$DMG_ROOT/.background/background.png"
cp "$ICON_ICNS" "$DMG_ROOT/.VolumeIcon.icns"
if command -v SetFile >/dev/null 2>&1; then
  SetFile -a C "$DMG_ROOT"
fi

echo "Creating DMG..."
hdiutil create -volname "$VOLUME_NAME" -srcfolder "$DMG_ROOT" -ov -format UDRW "$DMG_RW"

MOUNT_OUTPUT="$(hdiutil attach "$DMG_RW" -nobrowse -readwrite 2>&1)"
MOUNT_DIR="$(printf '%s\n' "$MOUNT_OUTPUT" | grep -o '/Volumes/.*' | tail -1)"
[[ -n "$MOUNT_DIR" && -d "$MOUNT_DIR" ]] || {
  echo "Failed to mount DMG for styling." >&2
  exit 1
}

cp "$ICON_ICNS" "$MOUNT_DIR/.VolumeIcon.icns"
if command -v SetFile >/dev/null 2>&1; then
  SetFile -a C "$MOUNT_DIR"
fi

/usr/bin/osascript - "$MOUNT_DIR" "$VOLUME_NAME" <<'APPLESCRIPT'
on run argv
  set mountPath to item 1 of argv
  set volumeName to item 2 of argv
  set bgFile to POSIX file (mountPath & "/.background/background.png")
  tell application "Finder"
    tell disk volumeName
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set bounds of container window to {120, 120, 780, 520}
      set theViewOptions to icon view options of container window
      set arrangement of theViewOptions to not arranged
      set icon size of theViewOptions to 128
      try
        set background picture of theViewOptions to bgFile
      end try
      set position of item "RedGalaxy Native.app" of container window to {170, 210}
      set position of item "Applications" of container window to {470, 210}
      close
      open
      update without registering applications
      delay 1
    end tell
  end tell
end run
APPLESCRIPT

sync
hdiutil detach "$MOUNT_DIR" >/dev/null
hdiutil convert "$DMG_RW" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" >/dev/null
rm -f "$DMG_RW"

echo "Created: $DMG_PATH"
