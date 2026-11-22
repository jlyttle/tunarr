#!/bin/sh
# Daily launchd entry point: refresh yt-dlp (YouTube breaks old versions), then run.
# Runs from the dedicated app checkout, never the development checkout.
# The upgrade goes into the venv only (uv pip), so the tracked uv.lock is never rewritten
# and later `git pull` / checkouts in the app checkout stay clean.
set -u
cd "$(dirname "$0")/.." || exit 1
if ! uv pip install --python .venv/bin/python -U yt-dlp; then
  /usr/bin/osascript -e 'display notification "yt-dlp update failed; running with the installed version" with title "Tunarr commercials"'
fi
exec .venv/bin/commercials run
