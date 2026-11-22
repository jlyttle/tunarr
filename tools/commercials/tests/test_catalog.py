import json
from datetime import date
from pathlib import Path

import pytest

from commercials import catalog as cat
from commercials.catalog import Ad, Catalog, Compilation, load_catalog, save_catalog
from commercials.paths import media_root, state_root


def comp(status="new"):
    return Compilation("abc", "80s ads", date(2026, 1, 2), {"modern", "retro"}, status)


def ad():
    return Ad("a1", "fp", 30.5, {"retro"}, date(2026, 1, 2), date(2026, 2, 3), ["abc"],
              "ads/a1.mp4", {"retro": "/remote/retro/a1.mp4"}, "active")


def test_roundtrip(tmp_path: Path):
    c = Catalog()
    c.upsert_compilation(comp())
    c.ads["a1"] = ad()
    p = tmp_path / "catalog.json"
    save_catalog(c, p)
    assert load_catalog(p) == c
    assert json.loads(p.read_text())["ads"]["a1"]["delivered"] == {"retro": "/remote/retro/a1.mp4"}


def test_load_missing_is_empty(tmp_path: Path):
    assert load_catalog(tmp_path / "nope.json") == Catalog()


def test_upsert_idempotent():
    c = Catalog()
    assert c.upsert_compilation(comp()) is True
    c.compilations["abc"].status = "split"
    assert c.upsert_compilation(comp()) is False
    assert len(c.compilations) == 1
    assert c.compilations["abc"].status == "split"


def test_save_is_atomic(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    p = tmp_path / "catalog.json"
    old = Catalog()
    old.upsert_compilation(comp())
    save_catalog(old, p)
    new = Catalog()

    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(cat.json, "dump", boom)
    with pytest.raises(RuntimeError):
        save_catalog(new, p)
    monkeypatch.undo()
    assert load_catalog(p) == old
    assert [f.name for f in tmp_path.iterdir()] == ["catalog.json"]


def test_paths_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("COMMERCIALS_MEDIA", str(tmp_path / "m"))
    monkeypatch.setenv("COMMERCIALS_STATE", str(tmp_path / "s"))
    assert media_root() == tmp_path / "m"
    assert state_root() == tmp_path / "s"


def test_paths_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("COMMERCIALS_MEDIA", raising=False)
    assert media_root() == Path.home() / "Media" / "tunarr-commercials"
