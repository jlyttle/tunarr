import re
import subprocess
from datetime import date
from pathlib import Path

import pytest

from commercials import discover as discover_mod
from commercials.catalog import Catalog, Compilation
from commercials.discover import load_sources, new_compilations, parse_flat_playlist, pools_for_title

SOURCES = Path(__file__).parent.parent / "config" / "sources.json"


def test_pools_for_title():
    s = load_sources(SOURCES)
    assert pools_for_title("Nickelodeon Commercials 2026 Vol. 12", s) == {"kids"}
    assert pools_for_title("2026 Commercials Vol. 239", s) == {"general"}


def test_parse_flat_playlist():
    jsonl = (
        '{"id": "abc123", "title": "Nick Ads Vol. 1", "upload_date": "20261115"}\n'
        "\n"
        '{"id": "def456", "title": "Other Ads", "upload_date": "20261101"}\n'
    )
    assert parse_flat_playlist(jsonl) == [
        ("abc123", "Nick Ads Vol. 1", date(2026, 11, 15)),
        ("def456", "Other Ads", date(2026, 11, 1)),
    ]


def test_new_compilations_skips_known_and_old():
    s = load_sources(SOURCES)
    catalog = Catalog()
    catalog.upsert_compilation(Compilation("known", "Known", date(2026, 11, 10), {"general"}, "downloaded"))
    entries = [
        ("known", "Known", date(2026, 11, 10)),
        ("old", "Old", date(2026, 1, 1)),
        ("fresh", "Nickelodeon Fresh", date(2026, 11, 12)),
    ]
    out = new_compilations(entries, catalog, date(2026, 10, 1), s)
    assert [c.video_id for c in out] == ["fresh"]
    assert out[0].pools == {"kids"}
    assert out[0].status == "new"


def test_parse_flat_playlist_missing_upload_date_is_none():
    assert parse_flat_playlist('{"id": "x1", "title": "No Date"}\n') == [("x1", "No Date", None)]


def _fail(*args):
    raise subprocess.CalledProcessError(1, ["yt-dlp"])


def test_fetch_upload_date_returns_none_on_failure(monkeypatch):
    monkeypatch.setattr(discover_mod, "_ytdlp", _fail)
    assert discover_mod.fetch_upload_date("x1") is None


def test_discover_skips_entry_when_fallback_fails(monkeypatch):
    def fake(*args):
        if "--flat-playlist" in args:
            return (
                '{"id": "nodate", "title": "Nick No Date"}\n'
                '{"id": "dated", "title": "Nick Dated", "upload_date": "20261115"}\n'
            )
        raise subprocess.CalledProcessError(1, ["yt-dlp"])

    monkeypatch.setattr(discover_mod, "_ytdlp", fake)
    s = load_sources(SOURCES)
    catalog = Catalog()
    out = discover_mod.discover(s, catalog, date(2026, 10, 1))
    assert [c.video_id for c in out] == ["dated"]
    assert "nodate" not in catalog.compilations


def test_adult_and_late_night_blocks_are_not_kids():
    s = load_sources(SOURCES)
    assert pools_for_title("Nick at Nite Commercials (2026)", s) == {"general"}
    assert pools_for_title("Adult Swim on Cartoon Network Commercials", s) == {"general"}
    assert pools_for_title("[as] Commercial Break Vol. 3", s) == {"general"}
    assert pools_for_title("Cartoon Network Commercials Vol. 3", s) == {"kids"}
    assert pools_for_title("Disney XD Commercials", s) == {"kids"}


NOT_KIDS = ["Nick-at-Nite Commercials 2026", "Nick at Night Commercials", "Nick@Nite Commercials",
            "NickAtNite Commercials", "TeenNick Commercials 2026", "AdultSwim Commercials",
            "Adult Swim on Cartoon Network Commercials", "[as] Commercials (Cartoon Network)",
            "Nick at Nite Commercials"]


@pytest.mark.parametrize("title", NOT_KIDS)
def test_adult_nick_and_adult_swim_spellings_never_map_to_kids(title):
    assert pools_for_title(title, load_sources(SOURCES)) == {"general"}


@pytest.mark.parametrize("title", ["Nickelodeon Commercials 2026", "Nick Jr. Commercials",
                                   "Nick Commercials (November 2026)", "Nicktoons Commercial Break"])
def test_kids_networks_map_to_kids(title):
    assert pools_for_title(title, load_sources(SOURCES)) == {"kids"}


@pytest.mark.parametrize("title", NOT_KIDS)
def test_never_kids_networks_guard_overrides_a_loose_kids_pattern(title):
    s = load_sources(SOURCES)
    s.patterns = [(re.compile(r"(?i)nick|adult|cartoon|\[as\]"), "kids")]
    assert pools_for_title(title, s) == {"general"}


def test_never_kids_guard_keeps_other_pools():
    s = load_sources(SOURCES)
    s.patterns = [(re.compile(r"(?i)nick"), "kids"), (re.compile(r"(?i)nick"), "general")]
    assert pools_for_title("TeenNick Commercials", s) == {"general"}


def test_never_kids_guard_with_kids_default_pool_falls_back_to_general():
    s = load_sources(SOURCES)
    s.patterns, s.default_pool = [], "kids"
    assert pools_for_title("Adult Swim Commercials", s) == {"general"}
    assert pools_for_title("Toy Commercials", s) == {"kids"}
