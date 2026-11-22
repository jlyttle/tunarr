"""Networks a compilation or chapter title can name (config/networks.json).

A compilation whose title names a network is "per-network": it is processed only when
every named network has hand-picked promo references (`network_refs/<slug>.json`), and
its segments must each match one chapter. Chapter text that names a network, or reads
like a promo, rejects the segment.
"""
import json
import re
from dataclasses import dataclass
from pathlib import Path

PROMO_WORDS = re.compile(r"\b(?:promos?|bumpers?|coming\s+up|up\s+next|next\s+on|station\s+ids?)\b", re.I)


@dataclass(frozen=True)
class Network:
    slug: str
    name: str
    patterns: tuple[re.Pattern, ...]

    def named_in(self, text: str) -> bool:
        return any(p.search(text) for p in self.patterns)


def load_networks(path: Path) -> list[Network]:
    raw = json.loads(Path(path).read_text())
    return [Network(n["slug"], n["name"], tuple(re.compile(p, re.I) for p in n["patterns"]))
            for n in raw["networks"]]


def networks_in(text: str, networks: list[Network]) -> list[str]:
    """Sorted slugs of every network the text names."""
    return sorted({n.slug for n in networks if n.named_in(text)})


def missing_refs(slugs: list[str], refs_dir: Path) -> list[str]:
    """The slugs without a `<refs_dir>/<slug>.json` reference file."""
    return [s for s in slugs if not (refs_dir / f"{s}.json").exists()]


def promo_chapter_text(text: str, networks: list[Network]) -> bool:
    """True when chapter text reads like a promo, bumper or ID, or names any network."""
    return bool(text) and (PROMO_WORDS.search(text) is not None or bool(networks_in(text, networks)))


def find_network(name: str, networks: list[Network]) -> Network | None:
    """The network whose slug or name is `name` (case and punctuation ignored)."""
    key = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return next((n for n in networks
                 if key in (n.slug, re.sub(r"[^a-z0-9]+", "-", n.name.lower()).strip("-"))), None)
