SUPPORT_WINDOW_MS = 60_000
MIN_SUPPORT = 2


def _support(rel: str, cut: int, cuts_by_episode: dict[str, list[int]], window_ms: int) -> int:
    return sum(
        1 for other, cuts in cuts_by_episode.items() if other != rel and any(abs(c - cut) <= window_ms for c in cuts)
    )


def supported_cuts(
    cuts_by_episode: dict[str, list[int]], window_ms: int = SUPPORT_WINDOW_MS, min_support: int = MIN_SUPPORT
) -> dict[str, list[int]]:
    return {
        rel: [c for c in cuts if _support(rel, c, cuts_by_episode, window_ms) >= min_support]
        for rel, cuts in cuts_by_episode.items()
    }
