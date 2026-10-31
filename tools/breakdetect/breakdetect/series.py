import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath

import numpy as np

from breakdetect.candidates import SAMPLE_MS, Candidate, aligned, dark_threshold
from breakdetect.features import THUMB_H, THUMB_W, Features

TRANSITION_FRAMES = 9
TRANSITION_END_BEFORE_GAP = 15
TRANSITION_START_BEFORE_GAP = TRANSITION_END_BEFORE_GAP + TRANSITION_FRAMES
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
class SeriesContext:
    offsets_by_episode: dict[str, list[int]]
    transitions_by_episode: dict[str, dict[int, Transition]]
    durations_ms: dict[str, int]
    seasons: dict[str, int | None]
    flat: np.ndarray
    coarse: np.ndarray
    owners: np.ndarray
    owner_index: dict[str, int]


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


def bumper_sequence(f: Features, c: Candidate) -> Transition | None:
    luma, _ = aligned(f)
    gap = c.start_ms // SAMPLE_MS
    first, stop = gap - TRANSITION_START_BEFORE_GAP, gap - TRANSITION_END_BEFORE_GAP
    if first < 0 or stop > len(f.thumbs) or stop > len(luma):
        return None
    if float(luma[first:stop].mean()) < dark_threshold(luma):
        return None
    return _downsample(f.thumbs[first:stop])


def _coarse(sequence: Transition) -> np.ndarray:
    frames, h, w = sequence.shape
    blocks = sequence.reshape(frames, h // COARSE_BLOCK_H, COARSE_BLOCK_H, w // COARSE_BLOCK_W, COARSE_BLOCK_W)
    return blocks.sum(axis=(2, 4), dtype=np.int32).reshape(-1).astype(np.float32)


def _summarize(f: Features, candidates: list[Candidate]) -> tuple[list[int], list[tuple[int, Transition]]]:
    sequences = [(c.cut_ms, bumper_sequence(f, c)) for c in candidates]
    return [c.cut_ms for c in candidates], [(cut, seq) for cut, seq in sequences if seq is not None]


def build_series_context_from(items: Iterable[EpisodeItem]) -> SeriesContext:
    offsets, durations, seasons = {}, {}, {}
    rows: list[Transition] = []
    keys: list[tuple[str, int]] = []
    for rel, f, candidates in items:
        cuts, sequences = _summarize(f, candidates)
        offsets[rel], durations[rel], seasons[rel] = cuts, f.duration_ms, season_of(rel)
        rows += [seq.copy() for _, seq in sequences]
        keys += [(rel, cut) for cut, _ in sequences]
    size = TRANSITION_FRAMES * SEQ_H * SEQ_W
    stacked = np.stack(rows) if rows else np.empty((0, TRANSITION_FRAMES, SEQ_H, SEQ_W), dtype=np.uint8)
    owner_index = {rel: i for i, rel in enumerate(offsets)}
    transitions: dict[str, dict[int, Transition]] = {rel: {} for rel in offsets}
    for row, (rel, cut) in zip(stacked, keys):
        transitions[rel][cut] = row
    return SeriesContext(
        offsets_by_episode=offsets,
        transitions_by_episode=transitions,
        durations_ms=durations,
        seasons=seasons,
        flat=stacked.reshape(len(rows), size),
        coarse=np.array([_coarse(row) for row in stacked], dtype=np.float32).reshape(len(rows), -1),
        owners=np.array([owner_index[rel] for rel, _ in keys], dtype=np.int64),
        owner_index=owner_index,
    )


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


def _own_row(ctx: SeriesContext, rel: str, c: Candidate) -> np.ndarray | None:
    sequence = ctx.transitions_by_episode.get(rel, {}).get(c.cut_ms)
    return None if sequence is None else sequence.reshape(-1)


def _similarity(rows: np.ndarray, query: np.ndarray) -> np.ndarray:
    diff = np.maximum(rows, query) - np.minimum(rows, query)
    return 1.0 - diff.sum(axis=1, dtype=np.uint32) / (query.size * 255.0)


def _best_similarity(ctx: SeriesContext, query: np.ndarray, others: np.ndarray) -> float:
    query_coarse = _coarse(query.reshape(TRANSITION_FRAMES, SEQ_H, SEQ_W))
    bound = np.abs(ctx.coarse[others] - query_coarse).sum(axis=1) / query.size
    order = np.argsort(bound)
    best = 0.0
    for start in range(0, len(order), REFINE_CHUNK):
        chunk = order[start : start + REFINE_CHUNK]
        if 1.0 - bound[chunk[0]] / 255.0 <= best:
            break
        best = max(best, float(_similarity(ctx.flat[others[chunk]], query).max()))
    return best


def bumper_match(ctx: SeriesContext, rel: str, c: Candidate) -> float:
    others = _others(ctx, rel)
    query = _own_row(ctx, rel, c)
    if query is None or len(others) < MIN_OTHER_EPISODES:
        return 0.0
    rows = np.flatnonzero(ctx.owners != ctx.owner_index.get(rel, -1))
    return _best_similarity(ctx, query, rows) if len(rows) else 0.0
