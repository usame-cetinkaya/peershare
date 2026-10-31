#!/bin/sh
# Renders the PNG icons from icon.svg with headless Chrome (macOS).
set -e
cd "$(dirname "$0")/../public/icons"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d)

render() { # name size svg
  printf '<html><body style="margin:0;background:transparent">%s</body></html>' "$3" > "$TMP/$1.html"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --force-device-scale-factor=1 --window-size="$2,$2" --screenshot="$PWD/$1.png" "file://$TMP/$1.html" >/dev/null 2>&1
}

# Regular icon: rounded square.
REG=$(sed "s/<svg /<svg width=\"SIZE\" height=\"SIZE\" /" icon.svg)
# Maskable / Apple: full-bleed square, arrows shrunk into the safe zone.
FULL=$(echo "$REG" | sed 's/ rx="112"//; s/<g /<g transform="translate(256 256) scale(0.78) translate(-256 -256)" /')

render icon-192 192 "$(echo "$REG" | sed 's/SIZE/192/g')"
render icon-512 512 "$(echo "$REG" | sed 's/SIZE/512/g')"
render icon-maskable-512 512 "$(echo "$FULL" | sed 's/SIZE/512/g')"
render apple-touch-icon 180 "$(echo "$FULL" | sed 's/SIZE/180/g')"
rm -rf "$TMP"
ls -l *.png
