#!/usr/bin/env bash
# Regenerate the raster (PNG) artifacts from the SVG sources.
# Requires: inkscape, imagemagick (magick).
set -euo pipefail
cd "$(dirname "$0")"

LIGHT_BG="#ffffff"
DARK_BG="#0f172a"
CANVAS_W=2560
CANVAS_H=1280
CONTENT_W=1900
CONTENT_H=800

render_preview() {
	local src="$1" bg="$2" out="$3" # bg may be 'none' for transparency
	local tmp
	tmp="$(mktemp -t ef-logo-XXXXXX.png)"
	inkscape "$src" -o "$tmp" -w 3000
	magick "$tmp" -trim +repage \
		-resize "${CONTENT_W}x${CONTENT_H}" \
		-background "$bg" -gravity center \
		-extent "${CANVAS_W}x${CANVAS_H}" \
		-strip "$out"
	rm -f "$tmp"
	echo "wrote $out"
}

# The previews are built from the *-outlined.svg files so that no font needs to
# be installed. Regenerate those from lockup.svg / lockup-dark.svg only when the
# wordmark itself changes (see README.md).
render_preview lockup-outlined.svg "$LIGHT_BG" preview-light.png
render_preview lockup-dark-outlined.svg "$DARK_BG" preview-dark.png
render_preview lockup-outlined.svg none preview-transparent.png

# Where these land in the repo:
#   preview-dark.png        -> docs/public/preview.png   (og:image)
#   preview-transparent.png -> docs/public/preview-grey.png and ./preview-grey.png (README)
#   icon.svg / icon-white.svg -> docs/public/ (pwag regenerates the PWA icons from them)
