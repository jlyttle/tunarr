# Interlace metadata detection

Auto-deinterlace requires the transcode profile's deinterlace option to be
turned on and the stored video scan type to be `interlaced`. FFprobe field orders
`tt`, `bb`, `tb`, and `bt` are all recognized as interlaced.

## Repair existing programs

After installing a build containing this fix:

1. Open **System → Tasks**.
2. Find **DetectMissingInterlaceMetadataTask** (description: **Detect Missing
   Interlace Metadata**) and select **Run now**.
3. Follow the server logs for progress and completion counts.
4. Check an affected episode's stream details and start a new playback session.
   With deinterlacing enabled, a detected interlaced episode should now use a
   deinterlace filter.

The task probes all stored video versions whose scan type is unknown. It updates
only their scan type and modification timestamp. It does not change program IDs,
versions, durations, chapters, channel lineups, schedules, or custom shows.
Existing playback sessions are not restarted.

The task probes up to two sources concurrently, with a 30-second timeout per
probe. Unreachable sources and inconclusive results remain unknown; rerun the
task to retry them. Successful detections are skipped on later runs.

## Future imports and rescans

Imports and rescans detect unknown scan types after saving program metadata.
They use the same local paths, path replacements, and authenticated remote
sources as playback. Detection adds time to scanning, not to playback startup.
A rescan that replaces previously detected metadata with unknown information
will probe that version again.

Known scan types are trusted. Detection reads ffprobe stream metadata; it does
not analyze decoded frames. Files whose raw field order is unknown remain
unknown and will not automatically deinterlace.
