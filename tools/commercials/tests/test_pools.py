from commercials.pools import apply_blocklist, chapter_text_for

BL = ["beer", "casino"]
CH = [
    {"start_time": 0.0, "end_time": 30.0, "title": "Toy Ad"},
    {"start_time": 30.0, "end_time": 60.0, "title": "Cold BEER"},
    {"start_time": 60.0, "end_time": 90.0, "title": "Cereal"},
    {"start_time": 90.0, "end_time": 120.0, "title": "Far Away"},
]


def test_blocklist_moves_to_general():
    assert apply_blocklist("cold beer", {"kids"}, BL) == {"general"}
    assert apply_blocklist("cold beer", {"kids", "general"}, BL) == {"general"}


def test_blocklist_no_hit_or_no_text():
    assert apply_blocklist("cereal", {"kids"}, BL) == {"kids"}
    assert apply_blocklist("", {"kids"}, BL) == {"kids"}


def test_chapter_text_includes_neighbours():
    assert chapter_text_for(30.2, CH) == "toy ad cold beer cereal"
    assert chapter_text_for(29.5, CH) == "toy ad cold beer cereal"
    assert chapter_text_for(0.0, CH) == "toy ad cold beer"
    assert chapter_text_for(95.0, CH) == "cereal far away"


def test_chapter_text_empty_without_chapters():
    assert chapter_text_for(10.0, []) == ""
