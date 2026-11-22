import os
from pathlib import Path


def media_root() -> Path:
    return Path(os.environ.get("COMMERCIALS_MEDIA") or "~/Media/tunarr-commercials").expanduser()


def state_root() -> Path:
    return Path(os.environ.get("COMMERCIALS_STATE") or "~/.local/share/tunarr-commercials").expanduser()


PACKAGE_CONFIG = Path(__file__).resolve().parent.parent / "config"


def config_dir() -> Path:
    """`$COMMERCIALS_CONFIG`, else the config/ folder of the checkout the package runs from."""
    env = os.environ.get("COMMERCIALS_CONFIG")
    return Path(env).expanduser() if env else PACKAGE_CONFIG
