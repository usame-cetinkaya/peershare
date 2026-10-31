#!/bin/sh
# Builds mac/build/PeerShare.app (Apple Silicon, ad-hoc signed) with just the
# Command Line Tools. VERSION=1.2.3 sets the version, DEBUG=1 makes the page
# inspectable, INSTALL=1 copies the app to /Applications.
set -e
cd "$(dirname "$0")"
VERSION=${VERSION:-0.0.0}
APP=build/PeerShare.app
EXT=$APP/Contents/PlugIns/PeerShareShare.appex
FLAGS="-target arm64-apple-macos13 -swift-version 5"
if [ -n "$DEBUG" ]; then FLAGS="$FLAGS -Onone -g -D DEBUG"; else FLAGS="$FLAGS -O"; fi

rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$EXT/Contents/MacOS"
sed "s/VERSION/$VERSION/g" Resources/App-Info.plist > "$APP/Contents/Info.plist"
sed "s/VERSION/$VERSION/g" Resources/Share-Info.plist > "$EXT/Contents/Info.plist"
cp Resources/AppIcon.icns "$APP/Contents/Resources/"

swiftc $FLAGS Sources/App/*.swift -o "$APP/Contents/MacOS/PeerShare"
swiftc $FLAGS -parse-as-library -application-extension Sources/Share/*.swift \
  -o "$EXT/Contents/MacOS/PeerShareShare" -Xlinker -e -Xlinker _NSExtensionMain

# Share extensions must be sandboxed; sign the inside first.
codesign -f -s - --entitlements Resources/Share.entitlements "$EXT"
codesign -f -s - "$APP"

if [ -n "$INSTALL" ]; then
  osascript -e 'quit app "PeerShare"' 2>/dev/null || true
  rm -rf /Applications/PeerShare.app
  cp -R "$APP" /Applications/
  LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  # Only the installed copy should answer peershare:// links.
  "$LSREGISTER" -u "$PWD/$APP" 2>/dev/null || true
  "$LSREGISTER" -f /Applications/PeerShare.app
  echo "Installed /Applications/PeerShare.app"
fi
