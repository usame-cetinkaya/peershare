#!/bin/sh
# Renders mac/Resources/AppIcon.icns from public/icons/icon.svg with headless
# Chrome: the rounded square at macOS icon size (824 of 1024) with a soft shadow.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d)
SVG=$(sed 's/<svg /<svg width="824" height="824" /' ../public/icons/icon.svg)
printf '<html><body style="margin:0;background:transparent"><div style="position:absolute;left:100px;top:90px;width:824px;height:824px;filter:drop-shadow(0 10px 14px rgba(0,0,0,.28))">%s</div></body></html>' "$SVG" > "$TMP/icon.html"
"$CHROME" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
  --force-device-scale-factor=1 --window-size=1024,1024 --screenshot="$TMP/icon.png" "file://$TMP/icon.html" >/dev/null 2>&1
SET="$TMP/AppIcon.iconset"
mkdir "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$TMP/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o Resources/AppIcon.icns
cp "$TMP/icon.png" "${PREVIEW:-/dev/null}" 2>/dev/null || true
rm -rf "$TMP"
ls -l Resources/AppIcon.icns
