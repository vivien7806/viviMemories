#!/bin/sh
# Installateur Windows construit depuis Linux/WSL, sans Node ni npm sur Windows.
# node_modules du conteneur est séparé de celui de l'hôte (binaires Linux pour les tests).
set -e
cd "$(dirname "$0")/.."

docker run --rm \
  -v "$PWD":/project \
  -v /project/node_modules \
  -v vivimemories-build-cache:/root/.cache \
  -e HOST_ID="$(id -u):$(id -g)" \
  -w /project \
  electronuserland/builder:22-wine-10.26 \
  sh -c '
    set -e
    trap "chown -R \$HOST_ID dist release 2>/dev/null || true" EXIT
    npm ci
    rm -f node_modules/ffmpeg-static/ffmpeg
    npm_config_platform=win32 npm_config_arch=x64 node node_modules/ffmpeg-static/install.js
    npm run build
    npx electron-builder --win
  '

# Exécutable depuis WSL : ./release/viviMemories\ Setup\ *.exe
chmod +x release/*.exe
ls -lh release/*.exe
