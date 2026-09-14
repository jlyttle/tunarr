# Episode break regression cases

`manifest.example.json` is a template for complete episode labels and media-backed evaluation.

`extended-black-1503.json` preserves an actual `conservative-fade-v1` analysis submitted by the user. Library identifiers and the source fingerprint have been removed/replaced; candidate measurements and detector configuration are unchanged.

The user manually confirmed legitimate breaks at approximately **9:24** and **15:03**. Use **564000 ms** and **903000 ms**, each with **±2000 ms** tolerance, as positive labels.

| Confirmed label | Archived candidate | Black duration | Silence overlap | Visual difference |
| --- | --- | --- | --- | --- |
| 9:24 | 564100 ms | 2900 ms | 1600 ms | 0.09146 |
| 15:03 | 903550 ms | 3500 ms | 1100 ms | 0.08387 |

Both candidates were rejected because their black intervals exceeded the 2000 ms limit, the fade heuristic returned false, and visual difference fell below 0.18. Silence overlap passed in both cases.

This case is **partially labeled development data**. Points at 1:29.100 and 2:30.050 remain suggestions for manual review, not confirmed breaks or confirmed negatives. Do not compute whole-episode precision or treat detections elsewhere as false positives from this fixture. Do not use it for held-out qualification.

The v2 four-minute edge policy excludes both unverified opening points regardless of their semantic labels. The eligible scan interval for this 21:15.258 episode is 4:00.000–17:15.200, retaining both confirmed breaks. The saved v1 measurements and configuration remain unchanged for comparison.

The regression tests preserve the distinction between finding the correct transitions and accepting them: the archived candidates match both positive labels, while the archived accepted candidates miss both. Those assertions describe the saved v1 baseline; they do not require future detector versions to keep rejecting these breaks.

The payload contains summarized candidate evidence, not frame samples, audio samples, or media. It cannot replay feature extraction or establish why the fade heuristic failed. Once the original episode is available, retain this baseline, label the rest of the episode, and create a development evaluation manifest referencing the media. The detector improvement should accept the confirmed boundary within tolerance while retaining the negative-case safeguards. Do not fabricate frame/audio data from the aggregate evidence or relax rules solely to make this one saved payload pass.

## Media-derived v3 regression

`real-transition-features.json` contains four 32-second windows extracted from the original episode using the production FFmpeg extractor (32×18 grayscale at 10 Hz, per-channel RMS audio summary). Each `features` field is a base64-encoded zlib/DEFLATE JSON object; its video pixels are base64 bytes. Offsets remain episode-relative. No full-resolution video or audio is included.

The two confirmed points must now be accepted within ±2 seconds. The other two candidates remain unlabeled and rejected; that assertion preserves diagnostic behavior without labeling them ground-truth negatives. Counterfactual tests mutate extracted samples to exercise abrupt black cuts, scene continuity, silent surroundings, insufficient silence, and chapter exclusions. These are synthetic negative tests, not additional manually labeled media.

The original v1 archive remains unchanged. V3 uses relative fades, spatial comparison independent of brightness, and stronger evidence for extended black intervals. This is development data, not held-out qualification; general precision still requires separately labeled episodes.

To replay the entire eligible interval from the original episode, set `TUNARR_BREAK_REGRESSION_MEDIA` to its local path when running `BreakMediaRegression.test.ts`. Without that variable, the media-dependent test is skipped and portable feature tests still run.

V4 additionally tests both confirmed transitions with black pixels clamped to floors of 2, 3, and 5 out of 255, recomputing frame measurements. These controlled variants reproduce the failure of the v3 near-zero hold without claiming to reproduce the server decoder: its exact black-level measurements were not present in the payload. The redundant near-zero hold is removed, and fade decrease is measured relative to the observed black level; the combined fade, black-duration, silence, spatial-change, and context requirements remain.
