#!/bin/sh
# Daily launchd entry point: refresh yt-dlp (YouTube breaks old versions), then run.
# Runs from the dedicated app checkout, never the development checkout.
set -u
cd "$(dirname "$0")/.." || exit 1
if ! uv sync --upgrade-package yt-dlp; then
  /usr/bin/osascript -e 'display notification "yt-dlp update failed; running with the installed version" with title "Tunarr commercials"'
fi
exec .venv/bin/commercials run
