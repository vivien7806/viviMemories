#!/bin/sh
# Version web pour GitHub Pages. Pages n'envoie pas les en-têtes COOP/COEP : coi-serviceworker
# les ajoute, la page est isolée et ffmpeg.wasm peut utiliser plusieurs cœurs.
set -e
cd "$(dirname "$0")/.."

npm run build:web
cp node_modules/coi-serviceworker/coi-serviceworker.min.js dist/web/
sed -i 's|<head>|<head>\n<script src="coi-serviceworker.min.js"></script>|' dist/web/index.html
