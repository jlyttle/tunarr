from datetime import date
from pathlib import Path

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
