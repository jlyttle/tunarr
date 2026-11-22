from pathlib import Path

import pytest

from commercials.networks import load_networks, missing_refs, networks_in, promo_chapter_text
from commercials.promo_filter import _slug

NETWORKS = Path(__file__).parent.parent / "config" / "networks.json"


@pytest.fixture(scope="module")
def nets():
    return load_networks(NETWORKS)


def test_config_slugs_match_add_ref_file_names(nets):
    # add-ref writes network_refs/<_slug(name)>.json, so the gate must look for the same name
    for n in nets:
        assert n.slug == _slug(n.name)


def test_config_lists_the_ruled_networks(nets):
    slugs = {n.slug for n in nets}
    for s in ("nickelodeon", "nick-jr", "nicktoons", "nick-at-nite", "cartoon-network", "boomerang",
              "disney-channel", "disney-xd", "disney-junior", "comedy-central", "fx", "fxx",
              "adult-swim", "mtv", "tbs", "tnt", "usa-network", "syfy", "food-network", "hgtv", "espn"):
        assert s in slugs


@pytest.mark.parametrize("title,expected", [
    ("Nickelodeon Commercials 2026 Vol. 12", ["nickelodeon"]),
    ("Nick Commercials (November 2026)", ["nickelodeon"]),
    ("Nick Jr. Commercials 2026", ["nick-jr"]),
    ("Nicktoons Commercial Break", ["nicktoons"]),
    ("Nick at Nite Commercials", ["nick-at-nite"]),
    ("Disney XD Commercials Vol. 4", ["disney-xd"]),
    ("Disney Junior Commercials", ["disney-junior"]),
    ("Disney Jr. Commercials", ["disney-junior"]),
    ("Disney Channel Commercials", ["disney-channel"]),
    ("Adult Swim on Cartoon Network", ["adult-swim", "cartoon-network"]),
    ("[as] commercials", ["adult-swim"]),
    ("Vol. 1 (Comedy Central)", ["comedy-central"]),
    ("FXX Commercials", ["fxx"]),
    ("FX Commercials", ["fx"]),
    ("USA Network Commercials", ["usa-network"]),
    ("2026 Commercials Vol. 239", []),
])
def test_networks_in_title(nets, title, expected):
    assert networks_in(title, nets) == expected


def test_missing_refs(tmp_path):
    (tmp_path / "disney-xd.json").write_text("{}")
    assert missing_refs(["disney-xd", "nickelodeon"], tmp_path) == ["nickelodeon"]
    assert missing_refs(["disney-xd"], tmp_path) == []
    assert missing_refs([], tmp_path / "none") == []


@pytest.mark.parametrize("text", [
    "spongebob promo", "cn bumper", "coming up next: kiff", "up next", "next on nick",
    "station id", "nickelodeon", "disney xd presents", "new episodes promos",
])
def test_promo_chapter_text_hits(nets, text):
    assert promo_chapter_text(text, nets)


@pytest.mark.parametrize("text", ["", "toy commercial", "pet smart - hank, the good boy commercial",
                                  "promotional price on cereal"])
def test_promo_chapter_text_clean(nets, text):
    assert not promo_chapter_text(text, nets)
