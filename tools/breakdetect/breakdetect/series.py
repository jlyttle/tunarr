import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath

import numpy as np

from breakdetect.candidates import SAMPLE_MS, Candidate, aligned, dark_threshold
from breakdetect.features import THUMB_H, THUMB_W, Features

TRANSITION_FRAMES = 9
TRANSITION_NEAR_GAP = 15
TRANSITION_FAR_GAP = TRANSITION_NEAR_GAP + TRANSITION_FRAMES
ABSOLUTE_TOLERANCE_MS = 20_000
RELATIVE_TOLERANCE = 0.02
SAME_SEASON_WEIGHT = 1.0
OTHER_SEASON_WEIGHT = 0.5
MIN_OTHER_EPISODES = 2
DOWNSAMPLE = 2
SEQ_H, SEQ_W = THUMB_H // DOWNSAMPLE, THUMB_W // DOWNSAMPLE
COARSE_BLOCK_H, COARSE_BLOCK_W = 6, 8
REFINE_CHUNK = 32
SEASON_PATTERN = re.compile(r"season\s+(\d+)", re.IGNORECASE)

Transition = np.ndarray
EpisodeItem = tuple[str, Features, list[Candidate]]


@dataclass
class SequenceBank:
    transitions_by_episode: dict[str, dict[int, Transition]]
    flat: np.ndarray
    coarse: np.ndarray
    owners: np.ndarray


@dataclass
class SeriesContext:
    offsets_by_episode: dict[str, list[int]]
    durations_ms: dict[str, int]
    seasons: dict[str, int | None]
    owner_index: dict[str, int]
    before: SequenceBank
    after: SequenceBank


def season_of(rel: str) -> int | None:
    for part in PurePosixPath(rel).parts[:-1]:
        match = SEASON_PATTERN.search(part)
        if match:
            return int(match.group(1))
    return None


def sibling_weight(a: int | None, b: int | None) -> float:
    return SAME_SEASON_WEIGHT if a is not None and a == b else OTHER_SEASON_WEIGHT


def _downsample(frames: np.ndarray) -> Transition:
    count = len(frames)
    blocks = frames.reshape(count, SEQ_H, DOWNSAMPLE, SEQ_W, DOWNSAMPLE)
    return (blocks.sum(axis=(2, 4), dtype=np.uint16) // (DOWNSAMPLE * DOWNSAMPLE)).astype(np.uint8)


def _sequence(f: Features, first: int, stop: int) -> Transition | None:
    luma, _ = aligned(f)
    if first < 0 or stop > len(f.thumbs) or stop > len(luma):
        return None
    if float(luma[first:stop].mean()) < dark_threshold(luma):
        return None
    return _downsample(f.thumbs[first:stop])


def bumper_sequence(f: Features, c: Candidate) -> Transition | None:
    gap = c.start_ms // SAMPLE_MS
    return _sequence(f, gap - TRANSITION_FAR_GAP, gap - TRANSITION_NEAR_GAP)


def return_sequence(f: Features, c: Candidate) -> Transition | None:
    gap_end = c.end_ms // SAMPLE_MS
    return _sequence(f, gap_end + TRANSITION_NEAR_GAP, gap_end + TRANSITION_FAR_GAP)


def _coarse(sequence: Transition) -> np.ndarray:
    frames, h, w = sequence.shape
    blocks = sequence.reshape(frames, h // COARSE_BLOCK_H, COARSE_BLOCK_H, w // COARSE_BLOCK_W, COARSE_BLOCK_W)
    return blocks.sum(axis=(2, 4), dtype=np.int32).reshape(-1).astype(np.float32)


SequenceFn = Callable[[Features, Candidate], Transition | None]


def _sequences(f: Features, candidates: list[Candidate], fn: SequenceFn) -> list[tuple[int, Transition]]:
    found = [(c.cut_ms, fn(f, c)) for c in candidates]
    return [(cut, seq) for cut, seq in found if seq is not None]


def _bank(keyed: list[tuple[str, int, Transition]], owner_index: dict[str, int]) -> SequenceBank:
    size = TRANSITION_FRAMES * SEQ_H * SEQ_W
    coarse_size = TRANSITION_FRAMES * (SEQ_H // COARSE_BLOCK_H) * (SEQ_W // COARSE_BLOCK_W)
    stacked = np.stack([seq for _, _, seq in keyed]) if keyed else np.empty((0, TRANSITION_FRAMES, SEQ_H, SEQ_W), dtype=np.uint8)
    transitions: dict[str, dict[int, Transition]] = {rel: {} for rel in owner_index}
    for row, (rel, cut, _) in zip(stacked, keyed):
        transitions[rel][cut] = row
    return SequenceBank(
        transitions_by_episode=transitions,
        flat=stacked.reshape(len(keyed), size),
        coarse=np.array([_coarse(row) for row in stacked], dtype=np.float32).reshape(len(keyed), coarse_size),
        owners=np.array([owner_index[rel] for rel, _, _ in keyed], dtype=np.int64),
    )


def build_series_context_from(items: Iterable[EpisodeItem]) -> SeriesContext:
    offsets, durations, seasons = {}, {}, {}
    before: list[tuple[str, int, Transition]] = []
    after: list[tuple[str, int, Transition]] = []
    for rel, f, candidates in items:
        offsets[rel], durations[rel], seasons[rel] = [c.cut_ms for c in candidates], f.duration_ms, season_of(rel)
        before += [(rel, cut, seq.copy()) for cut, seq in _sequences(f, candidates, bumper_sequence)]
        after += [(rel, cut, seq.copy()) for cut, seq in _sequences(f, candidates, return_sequence)]
    owner_index = {rel: i for i, rel in enumerate(offsets)}
    return SeriesContext(offsets, durations, seasons, owner_index, _bank(before, owner_index), _bank(after, owner_index))


def build_series_context(episodes: Mapping[str, tuple[Features, list[Candidate]]]) -> SeriesContext:
    return build_series_context_from((rel, f, candidates) for rel, (f, candidates) in episodes.items())


def _others(ctx: SeriesContext, rel: str) -> list[str]:
    return [other for other in ctx.offsets_by_episode if other != rel]


def _is_near(offsets: np.ndarray, duration_ms: int, c: Candidate, own_duration_ms: int) -> bool:
    absolute = np.abs(offsets - c.cut_ms) <= ABSOLUTE_TOLERANCE_MS
    relative = np.abs(offsets / duration_ms - c.cut_ms / own_duration_ms) <= RELATIVE_TOLERANCE
    return bool((absolute | relative).any())


def offset_support(ctx: SeriesContext, rel: str, c: Candidate) -> float:
    others = _others(ctx, rel)
    if len(others) < MIN_OTHER_EPISODES:
        return 0.0
    weights = {o: sibling_weight(ctx.seasons[rel], ctx.seasons[o]) for o in others}
    supporting = sum(
        weights[o]
        for o in others
        if ctx.offsets_by_episode[o]
        and _is_near(np.array(ctx.offsets_by_episode[o]), ctx.durations_ms[o], c, ctx.durations_ms[rel])
    )
    return supporting / sum(weights.values())


def _own_row(bank: SequenceBank, rel: str, c: Candidate) -> np.ndarray | None:
    sequence = bank.transitions_by_episode.get(rel, {}).get(c.cut_ms)
    return None if sequence is None else sequence.reshape(-1)


def _similarity(rows: np.ndarray, query: np.ndarray) -> np.ndarray:
    diff = np.maximum(rows, query) - np.minimum(rows, query)
    return 1.0 - diff.sum(axis=1, dtype=np.uint32) / (query.size * 255.0)


def _best_similarity(bank: SequenceBank, query: np.ndarray, others: np.ndarray) -> float:
    query_coarse = _coarse(query.reshape(TRANSITION_FRAMES, SEQ_H, SEQ_W))
    bound = np.abs(bank.coarse[others] - query_coarse).sum(axis=1) / query.size
    order = np.argsort(bound)
    best = 0.0
    for start in range(0, len(order), REFINE_CHUNK):
        chunk = order[start : start + REFINE_CHUNK]
        if 1.0 - bound[chunk[0]] / 255.0 <= best:
            break
        best = max(best, float(_similarity(bank.flat[others[chunk]], query).max()))
    return best


def _bank_match(ctx: SeriesContext, bank: SequenceBank, rel: str, c: Candidate) -> float:
    query = _own_row(bank, rel, c)
    if query is None or len(_others(ctx, rel)) < MIN_OTHER_EPISODES:
        return 0.0
    rows = np.flatnonzero(bank.owners != ctx.owner_index.get(rel, -1))
    return _best_similarity(bank, query, rows) if len(rows) else 0.0


def bumper_match(ctx: SeriesContext, rel: str, c: Candidate) -> float:
    return _bank_match(ctx, ctx.before, rel, c)


def return_match(ctx: SeriesContext, rel: str, c: Candidate) -> float:
    return _bank_match(ctx, ctx.after, rel, c)
