# ethereum-indexer logo

The mark is an ether diamond built out of stacked index rows, cut at the widest point by a single index beam that runs clean through both edges: the chain on one axis, the index on the other. The beam also reads as the live cursor sweeping the chain.

The geometry is deliberately all-straight to sit with Audiowide: the diamond's four points are chamfered into an octagon, so every silhouette edge is a flat cut, and the beam ends in points rather than caps. No curves anywhere in the mark.

## Files

SVG is the source of truth. Only the two `preview*.png` files are committed as raster; everything else is rendered on demand.

| file | what it is |
| --- | --- |
| `icon.svg` | the mark alone, slate `#64748B`, on transparent |
| `icon-white.svg` | the mark in white, for dark backgrounds |
| `icon-accent.svg` | the mark with the index beam in violet `#7C5CFF`, slate rows |
| `icon-accent-white.svg` | accent version for dark backgrounds, `#e2e8f0` rows |
| `lockup.svg` | mark + wordmark, live text (needs Audiowide installed to render correctly) |
| `lockup-dark.svg` | same lockup in `#e2e8f0`, for dark backgrounds |
| `lockup-outlined.svg` | `lockup.svg` with the wordmark converted to paths: no font needed, use this for embedding |
| `lockup-dark-outlined.svg` | dark variant, wordmark as paths |
| `preview-light.png` | 2560x1280 preview, white background |
| `preview-dark.png` | 2560x1280 preview, `#0f172a` background |
| `preview-transparent.png` | 2560x1280 preview, transparent background |
| `build.sh` | regenerates the two previews from the outlined SVGs |

Colors: slate `#64748B` (light backgrounds), `#e2e8f0` on `#0f172a` (dark backgrounds), optional accent `#7C5CFF`. Wordmark: [Audiowide](https://fonts.google.com/specimen/Audiowide) Regular (400), lowercase, 120px on the 1280x520 lockup canvas.

Audiowide is [SIL Open Font Licensed](https://openfontlicense.org). It is only needed to re-outline the wordmark, not to use the assets: the `*-outlined.svg` files and the PNGs carry the letterforms as paths.

## Generating the PNGs

Requires [Inkscape](https://inkscape.org) and [ImageMagick](https://imagemagick.org) (`magick`).

All three previews:

```sh
./build.sh
```

## Where these are used in the repo

These files are the source. Copies live where the site and the README expect them, so after a redesign they need to be pushed out again:

```sh
cp icon.svg icon-white.svg icon-accent.svg icon-accent-white.svg ../../../docs/public/
cp icon.svg ../../../examples/basic/public/icon.svg
cp preview-dark.png ../../../docs/public/preview.png              # og:image
cp preview-transparent.png ../../../docs/public/preview-grey.png  # docs/api index
cp preview-transparent.png ../../../preview-grey.png              # root README
```

`pnpm docs:build` runs `pwag` over `docs/public/icon.svg`, which regenerates the favicons, the apple touch icon and the PWA manifest icons in `docs/public/pwa` (gitignored). The docs site loads Audiowide from `docs/.vitepress/theme/fonts`.

Ad-hoc icon rasters, at any size:

```sh
inkscape icon.svg -o icon-512.png -w 512 -h 512
inkscape icon.svg -o icon-256.png -w 256 -h 256
inkscape icon-white.svg -o icon-white-512.png -w 512 -h 512
```

Add `-b '#ffffff'` to flatten onto a background instead of exporting with transparency.

A favicon (the stripes start to merge below ~24px, so prefer 32px or larger):

```sh
inkscape icon.svg -o favicon-32.png -w 32 -h 32
magick favicon-32.png favicon.ico
```

## Editing the wordmark

`lockup.svg` and `lockup-dark.svg` keep the wordmark as real `<text>`, so they are the ones to edit. After changing them, regenerate the outlined copies (this step needs Audiowide installed, e.g. `mkdir -p ~/.local/share/fonts && curl -sfLO --output-dir ~/.local/share/fonts https://raw.githubusercontent.com/google/fonts/main/ofl/audiowide/Audiowide-Regular.ttf && fc-cache -f`) and then rerun the previews:

```sh
inkscape lockup.svg --export-text-to-path -o lockup-outlined.svg
inkscape lockup-dark.svg --export-text-to-path -o lockup-dark-outlined.svg
./build.sh
```
