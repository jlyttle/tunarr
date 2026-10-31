#!/usr/bin/env bash
set -euo pipefail

HOST="${BREAKDETECT_HOST:-root@192.168.1.227}"
APPDATA=/mnt/user/appdata/breakdetect
MEDIA=/mnt/user/plex
IMAGE=breakdetect:local

if [ $# -eq 0 ]; then
    echo "usage: $0 <cmd> [args]   e.g. $0 breakdetect extract '/media/plex/Kids TV/Rugrats'" >&2
    echo "       $0 pull-cache     copy extracted features to this Mac's cache" >&2
    exit 2
fi

here="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$1" = "pull-cache" ]; then
    dest="${BREAKDETECT_CACHE:-$here/../../.local/breakdetect/features}"
    mkdir -p "$dest"
    rsync -a --chmod=D755,F644 "$HOST:$APPDATA/cache/features/" "$dest/"
    exit 0
fi

ssh "$HOST" "mkdir -p $APPDATA/src $APPDATA/cache $APPDATA/data"

rsync -a --delete \
    --exclude .venv --exclude .pytest_cache --exclude __pycache__ --exclude data \
    "$here/" "$HOST:$APPDATA/src/"

ssh "$HOST" "docker build -q -t $IMAGE -f $APPDATA/src/docker/Dockerfile $APPDATA/src >/dev/null"

quoted=$(printf '%q ' "$@")
ssh "$HOST" "docker run --rm --device /dev/dri \
    -v $MEDIA:/media/plex:ro \
    -v $APPDATA/cache:/cache \
    -v $APPDATA/data:/data \
    $IMAGE $quoted"
