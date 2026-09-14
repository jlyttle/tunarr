import {
  BreakAnalysisResultSchema,
  type BreakEvaluationManifestSchema,
  type BreakAnalysisResult,
} from '@tunarr/types/schemas';
import { z } from 'zod/v4';

export function matchBreakpoints(
  expected: number[],
  detected: number[],
  toleranceMs = 2000,
) {
  if (
    !Number.isFinite(toleranceMs) ||
    toleranceMs < 0 ||
    expected.length > 1000 ||
    detected.length > 1000 ||
    [...expected, ...detected].some((t) => !Number.isFinite(t) || t < 0)
  )
    throw new Error('Invalid matching input');
  const a = expected
    .map((timestamp, index) => ({ timestamp, index }))
    .sort((x, y) => x.timestamp - y.timestamp);
  const b = detected
    .map((timestamp, index) => ({ timestamp, index }))
    .sort((x, y) => x.timestamp - y.timestamp);
  type Cell = {
    count: number;
    error: number;
    move: 'expected' | 'detected' | 'match';
  };
  const cells: Cell[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => ({
      count: 0,
      error: 0,
      move: 'expected',
    })),
  );
  for (let i = a.length; i >= 0; i--) {
    for (let j = b.length; j >= 0; j--) {
      if (i === a.length && j === b.length) continue;
      const options: Cell[] = [];
      if (i < a.length)
        options.push({ ...cells[i + 1]![j]!, move: 'expected' });
      if (j < b.length)
        options.push({ ...cells[i]![j + 1]!, move: 'detected' });
      if (
        i < a.length &&
        j < b.length &&
        Math.abs(a[i]!.timestamp - b[j]!.timestamp) <= toleranceMs
      ) {
        const next = cells[i + 1]![j + 1]!;
        options.push({
          count: next.count + 1,
          error: next.error + Math.abs(a[i]!.timestamp - b[j]!.timestamp),
          move: 'match',
        });
      }
      cells[i]![j] = options.sort(
        (x, y) => y.count - x.count || x.error - y.error,
      )[0]!;
    }
  }
  const matches: {
    expectedMs: number;
    detectedMs: number;
    errorMs: number;
    expectedIndex: number;
    detectedIndex: number;
  }[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    const move = cells[i]![j]!.move;
    if (move === 'match') {
      matches.push({
        expectedMs: a[i]!.timestamp,
        detectedMs: b[j]!.timestamp,
        errorMs: b[j]!.timestamp - a[i]!.timestamp,
        expectedIndex: a[i]!.index,
        detectedIndex: b[j]!.index,
      });
      i++;
      j++;
    } else if (move === 'expected') i++;
    else j++;
  }
  return {
    matches,
    falsePositives: detected.filter(
      (_, index) => !matches.some((m) => m.detectedIndex === index),
    ),
    missedBreaks: expected.filter(
      (_, index) => !matches.some((m) => m.expectedIndex === index),
    ),
  };
}

export const EvaluationArtifactSchema = z.object({
  formatVersion: z.literal(1),
  datasetId: z.string(),
  kind: z.enum(['synthetic', 'real']),
  split: z.enum(['development', 'held-out']),
  toleranceMs: z.number().nonnegative(),
  createdAt: z.number(),
  episodes: z
    .array(
      z.object({
        id: z.string(),
        labels: z.array(z.string()),
        expectedBreaks: z.array(z.number()),
        result: BreakAnalysisResultSchema,
      }),
    )
    .min(1),
});
export type EvaluationArtifact = z.infer<typeof EvaluationArtifactSchema>;

export function makeEvaluation(
  manifest: z.infer<typeof BreakEvaluationManifestSchema>,
  results: BreakAnalysisResult[],
): EvaluationArtifact {
  if (manifest.episodes.length !== results.length)
    throw new Error('Missing evaluation results');
  return {
    formatVersion: 1,
    datasetId: manifest.datasetId,
    kind: manifest.kind,
    split: manifest.split,
    toleranceMs: manifest.toleranceMs,
    createdAt: Date.now(),
    episodes: manifest.episodes.map((episode, i) => ({
      id: episode.id,
      labels: episode.labels,
      expectedBreaks: episode.expectedBreaks,
      result: results[i]!,
    })),
  };
}

export function summarizeEvaluation(artifact: EvaluationArtifact) {
  const episodes = artifact.episodes.map((e) => {
    const detected =
      e.result.status === 'completed'
        ? e.result.candidates.filter((c) => c.accepted)
        : [];
    return {
      ...e,
      detected,
      ...matchBreakpoints(
        e.expectedBreaks,
        detected.map((c) => c.timestampMs),
        artifact.toleranceMs,
      ),
    };
  });
  const tp = episodes.reduce((n, e) => n + e.matches.length, 0);
  const fp = episodes.reduce((n, e) => n + e.falsePositives.length, 0);
  const fn = episodes.reduce((n, e) => n + e.missedBreaks.length, 0);
  return {
    episodes,
    matches: tp,
    falsePositives: fp,
    missedBreaks: fn,
    failures: episodes.filter((e) => e.result.status !== 'completed').length,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
  };
}

const escapeHtml = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const seconds = (ms: number) => (ms / 1000).toFixed(2);
export function renderEvaluation(artifact: EvaluationArtifact): string {
  const summary = summarizeEvaluation(artifact);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="generator" content="Tunarr episode break analysis"><meta name="viewport" content="width=device-width"><title>Episode break evaluation</title>
<style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#17212b}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #ccd3da;padding:8px;text-align:left}th{background:#edf2f7}pre{white-space:pre-wrap;overflow-wrap:anywhere}section{margin:32px 0}small{color:#445} .error{color:#a20}</style>
<h1>Episode break evaluation</h1><p>${escapeHtml(artifact.datasetId)} · ${escapeHtml(artifact.kind)} · ${escapeHtml(artifact.split)} · tolerance ±${seconds(artifact.toleranceMs)} seconds</p>
<p>Precision: ${summary.precision === null ? 'undefined (no detections)' : (100 * summary.precision).toFixed(1) + '%'} · Recall: ${summary.recall === null ? 'undefined (no labels)' : (100 * summary.recall).toFixed(1) + '%'} · Matches: ${summary.matches} · False positives: ${summary.falsePositives} · Missed: ${summary.missedBreaks} · Failed/skipped: ${summary.failures}</p>
<p>Confidence is an uncalibrated rule classification. This report evaluates experimental accepted candidates, independently of qualification. It does not enable playback.</p>
${summary.episodes
  .map(
    (
      e,
    ) => `<section><h2>${escapeHtml(e.id)}</h2><p>${escapeHtml(e.labels.join(', '))}</p><p>Status: ${escapeHtml(e.result.status)} ${escapeHtml(e.result.error ?? '')}</p>
<small>Detector ${escapeHtml(e.result.detectorVersion)} · config ${escapeHtml(e.result.configHash)} · source ${escapeHtml(e.result.sourceFingerprint)}</small>
<p>Expected (seconds): ${e.expectedBreaks.map(seconds).join(', ') || 'none'}<br>Detected: ${e.detected.map((d) => `${seconds(d.timestampMs)} (${d.confidence})`).join(', ') || 'none'}</p>
<table><tr><th>Expected</th><th>Detected</th><th>Timing error</th><th>Outcome</th></tr>
${e.matches.map((m) => `<tr><td>${seconds(m.expectedMs)}</td><td>${seconds(m.detectedMs)}</td><td>${seconds(m.errorMs)}</td><td>Matched</td></tr>`).join('')}
${e.falsePositives.map((t) => `<tr class="error"><td>—</td><td>${seconds(t)}</td><td>—</td><td>False positive</td></tr>`).join('')}
${e.missedBreaks.map((t) => `<tr><td>${seconds(t)}</td><td>—</td><td>—</td><td>Missed break</td></tr>`).join('')}</table>
<details><summary>Candidate evidence and rejection reasons (${e.result.candidates.length})</summary><pre>${escapeHtml(JSON.stringify(e.result.candidates, null, 2))}</pre></details></section>`,
  )
  .join('')}
</html>`;
}

export function qualificationDetails(artifact: EvaluationArtifact) {
  const report = summarizeEvaluation(artifact);
  const first = artifact.episodes[0]!.result;
  if (
    artifact.kind !== 'real' ||
    artifact.split !== 'held-out' ||
    !report.matches ||
    report.falsePositives ||
    report.failures ||
    artifact.episodes.some(
      (e) =>
        e.result.stale ||
        e.result.detectorVersion !== first.detectorVersion ||
        e.result.configHash !== first.configHash,
    )
  ) {
    throw new Error(
      'Qualification requires one detector/configuration, real held-out episodes, fresh completed results, at least one match, and zero false positives',
    );
  }
  return {
    detectorVersion: first.detectorVersion,
    configHash: first.configHash,
    datasetId: artifact.datasetId,
  };
}
