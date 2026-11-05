# Mid-Roll Breaks

Mid-roll breaks insert commercial-style breaks _within_ programs, splitting a long movie or episode into segments separated by filler content. This simulates the experience of traditional TV commercial breaks.

Mid-roll breaks are configured per-slot in the [Slot Editor](random-slots.md) and [Time Slots](time-slots.md) editors. Any slot type that supports [filler](../library/filler.md) also supports mid-roll breaks.

## Prerequisites

To use mid-roll breaks, you need:

1. A [filler list](../library/filler.md) with content (commercials, bumpers, etc.)
2. The filler list assigned to a slot with the **Mid** filler type

When editing a slot in the Slot Editor or Time Slots editor, add a filler list and select "Mid" as one of its types. Once a "Mid" filler is assigned, the mid-roll configuration panel appears.

## Break Positioning

Mid-roll breaks support four positioning rules that control _where_ breaks are inserted within a program.

### Fixed Interval

Inserts breaks at regular time intervals throughout the program.

| Setting | Description |
|---------|-------------|
| **Interval** | Time between breaks (e.g., every 30 minutes) |

A 2-hour movie with a 30-minute interval gets breaks at 30m, 60m, and 90m.

### Percentage-Based

Inserts breaks at specific points expressed as percentages of the program's total duration.

| Setting | Description |
|---------|-------------|
| **Points** | One or more percentage values (1–99%) |

A 2-hour movie with points at 25%, 50%, and 75% gets breaks at 30m, 60m, and 90m.

### Initial Delay + Interval

Combines an initial delay before the first break with a regular interval for subsequent breaks.

| Setting | Description |
|---------|-------------|
| **Initial Delay** | Time before the first break |
| **Interval** | Time between subsequent breaks |

A 2-hour movie with a 15-minute initial delay and 30-minute interval gets breaks at 15m, 45m, 75m, and 105m.

### Detected Breaks

Uses break positions found by breakdetect (`tools/breakdetect`), which scans episodes for the black-frame and silence gaps where the original broadcast cut to commercials. The rule has no settings of its own. Each episode breaks where its imported markers say.

An episode with no imported markers plays whole. See [Importing Markers](#importing-markers).

## Break Duration

Break duration can be configured in two modes:

- **Fixed**: Every break has the same duration (e.g., 3 minutes).
- **Range**: Each break's duration is randomly chosen between a minimum and maximum value (e.g., 2–5 minutes). This makes breaks feel less mechanical.

In a time slot, breaks only use the slot's spare time, which is the padding and flex left after its programs. They never push the slot past its end, so the next slot still starts on time. When the spare time runs low, a break is shortened to fit, but never below the minimum break duration (or the fixed duration). A break that cannot fit at that length is dropped, along with the rest of that program's breaks. For example, a 53-minute episode in a one-hour slot gets at most 7 minutes of breaks. A program's breaks use its own padding first, so the programs after it keep their start times.

### Split Slot Flex

Instead of a fixed or random break length, **Split slot flex** sizes the breaks from the slot's spare time, so a time slot fills to its end without a long filler gap after the last segment. It suits the Detected rule, where the number of breaks varies by episode.

| Setting | Description | Default |
|---------|-------------|---------|
| **Tail share** | Fraction of a program's share of spare time kept as flex after the last segment | 25% |
| **Minimum tail** | Smallest tail kept after the last segment | 1 minute |
| **Minimum break** | Breaks shorter than this are dropped | 1 minute |

- The slot's spare time is shared across its programs in proportion to their durations. A program that cannot use its share passes the rest on to later programs.
- Each program keeps a tail of at least the minimum tail, or its share times the tail share if that is larger. The rest is split evenly across its breaks.
- If breaks would come out shorter than the minimum break, the latest breaks are dropped until they fit.
- In random slots there is no fixed slot length, so each break is the minimum break.

## Limits and Filters

| Setting | Description | Default |
|---------|-------------|---------|
| **Max Breaks** | Maximum number of breaks per program. 0 = unlimited. | 0 |
| **Minimum Program Duration** | Programs shorter than this are skipped entirely. | Fitted to the slot |
| **Tail Buffer** | Minimum amount of content preserved at the end of the program before the credits. No breaks are inserted within this window. | 0 |
| **No break before** | No break is placed earlier than this into the program. Applies to every rule. | Off |
| **Minimum gap between breaks** | Breaks closer together than this are dropped. Applies to every rule. | Off |
| **Program Types** | Restrict mid-roll to specific content types (Movies, Episodes, Music Tracks, Music Videos, Other Videos). Empty = all types. | All |

### Starting Values

When mid-roll is first enabled on a slot, the interval and minimum program
duration are fitted to the programs that slot actually draws from: the interval
aims for about two breaks in a program of typical length, and the minimum sits
at or below the shortest program in the pool, so none of the slot's own content
is skipped. A slot whose pool cannot be measured — a smart collection, or a
channel whose programs have not loaded — starts at a 15 minute interval and a
20 minute minimum.

These are starting values, not rules. Raise the minimum to leave shorter
programs whole.

## Importing Markers

The Detected rule reads markers that breakdetect writes to `data/markers/<show>.json`. Import a file with one request:

```bash
curl -X POST -H 'Content-Type: application/json' \
  --data @data/markers/<show>.json \
  http://<tunarr-host>:8000/api/break-markers
```

An episode matches a program when the program's media file path ends with the episode's `relativePath` and the durations differ by no more than 2 seconds. The response lists how many episodes `matched` and which were `unmatched`. Importing a file again replaces the markers of the programs it matches.

With the Detected rule and no Mid filler list on the slot, breaks are filled from the channel's filler at play time.

## Scheduling Strategy

The scheduling strategy controls _when_ filler content is selected for mid-roll breaks.

### Eager

Filler is selected at **schedule generation time**. The specific filler programs are embedded directly into the channel lineup.

- The TV guide shows the actual filler titles during breaks.
- Filler selection uses cooldown state from the time the schedule was generated.
- Any part of a break that the filler lists cannot fill becomes flex. It is still
  break time, so the TV guide labels it "Commercial Break".

### Lazy

Filler selection is deferred to **stream time** — the moment a viewer is actually watching the channel. During schedule generation, placeholder "Commercial Break" entries are created.

- The TV guide shows generic "Commercial Break" entries.
- Filler selection uses fresh cooldown state, reducing repeats.
- Filler is drawn from the slot's mid-roll filler lists.

!!! tip
    Use the **Lazy** strategy if you want the most variety in your filler content. Because filler is picked at playback time, the system has up-to-date knowledge of what has recently played and can avoid repeats more effectively.

## In the Lineup Editor

A program that was split by mid-roll breaks appears as a single collapsed row in
the channel's program list, labelled with the number of breaks and showing where
they fall across the program. Expand the row to see each segment and each break
on its own line. This applies to both strategies.

## Example Configuration

To add 3-minute commercial breaks every 30 minutes to movies longer than 1 hour:

1. Open a slot in the Slot Editor or Time Slots editor.
2. Add a filler list and select the **Mid** type.
3. In the mid-roll configuration panel:
    - **Break Rule**: Fixed Interval, 30 minutes
    - **Break Duration**: Fixed, 3 minutes
    - **Minimum Program Duration**: 60 minutes
    - **Max Breaks**: 0 (unlimited)
    - **Strategy**: Lazy
    - **Program Types**: Movies only
