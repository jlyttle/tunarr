import os
from pathlib import Path


def media_root() -> Path:
    return Path(os.environ.get("COMMERCIALS_MEDIA") or "~/Media/tunarr-commercials").expanduser()


def state_root() -> Path:
    return Path(os.environ.get("COMMERCIALS_STATE") or "~/.local/share/tunarr-commercials").expanduser()


PACKAGE_CONFIG = Path(__file__).resolve().parent.parent / "config"


def config_dir() -> Path:
    return PACKAGE_CONFIG
