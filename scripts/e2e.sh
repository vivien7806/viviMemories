#!/bin/sh
# Fenêtres Electron dans un écran virtuel quand xvfb-run est installé : rien ne s'affiche à l'écran.
if command -v xvfb-run >/dev/null; then
  exec env -u WAYLAND_DISPLAY xvfb-run -a npx playwright test "$@"
fi
exec npx playwright test "$@"
