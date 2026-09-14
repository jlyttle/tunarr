import {
  BreakAnalysisRequestSchema,
  BreakAnalysisResultSchema,
  BreakDetectorConfigSchema,
  BreakEvaluationManifestSchema,
  type BreakAnalysisResult,
} from '@tunarr/types/schemas';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandModule } from 'yargs';
import { z } from 'zod/v4';
import { container } from '../container.ts';
import { BreakAnalysisService } from '../services/break-analysis/BreakAnalysisService.ts';
import {
  EvaluationArtifactSchema,
  makeEvaluation,
  qualificationDetails,
  renderEvaluation,
  summarizeEvaluation,
} from '../services/break-analysis/BreakEvaluation.ts';
import type { GlobalArgsType } from './types.ts';

type Args = GlobalArgsType & {
  action: 'analyze' | 'batch' | 'report' | 'evaluate' | 'qualify';
  file?: string;
  runtimeMs?: number;
  programId?: string;
  input?: string;
  output?: string;
  config?: string;
  force: boolean;
  videoStreamIndex?: number;
  audioStreamIndex?: number;
  timeoutMs: number;
  threads: number;
  acknowledgedBy?: string;
  acknowledge: boolean;
};
const readJson = async (file: string | undefined): Promise<unknown> => {
  if (!file) throw new Error('An --input file is required');
  const info = await fs.stat(file);
  if (info.size > 32 * 1024 * 1024)
    throw new Error('Input JSON exceeds 32 MiB');
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
};
export async function writeArtifact(file: string, content: string) {
  // An output typo must never replace media or another unrelated file.
  const existing = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.size > 32 * 1024 * 1024)
      throw new Error('Refusing to replace a non-artifact output');
    const text = await fs.readFile(file, 'utf8');
    let replaceable =
      text.startsWith('<!doctype html>') &&
      text.includes(
        '<meta name="generator" content="Tunarr episode break analysis">',
      );
    try {
      const parsed: unknown = JSON.parse(text);
      replaceable ||= z
        .union([
          BreakAnalysisResultSchema,
          z.array(BreakAnalysisResultSchema),
          EvaluationArtifactSchema,
        ])
        .safeParse(parsed).success;
    } catch {
      /* Existing media and unrelated text are not replaceable. */
    }
    if (!replaceable)
      throw new Error(
        'Refusing to overwrite media or an unrelated output file',
      );
  }
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { flag: 'wx' });
  try {
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export const BreakAnalysisCommand: CommandModule<GlobalArgsType, Args> = {
  command: 'break-analysis <action>',
  describe: 'Analyze episode breaks offline and evaluate experimental results',
  builder: (yargs) =>
    yargs
      .parserConfiguration({ 'camel-case-expansion': true })
      .positional('action', {
        type: 'string',
        demandOption: true,
        choices: ['analyze', 'batch', 'report', 'evaluate', 'qualify'] as const,
      })
      .option('file', {
        type: 'string',
        describe: 'Readable episode file (standalone analysis)',
      })
      .option('runtimeMs', {
        alias: 'runtime-ms',
        type: 'number',
        describe: 'Episode runtime in milliseconds',
      })
      .option('programId', {
        alias: 'program-id',
        type: 'string',
        describe: 'Registered episode UUID',
      })
      .option('input', {
        type: 'string',
        describe: 'Batch request, evaluation manifest, or result JSON',
      })
      .option('output', {
        type: 'string',
        describe: 'Output JSON path; report writes HTML here',
      })
      .option('config', {
        type: 'string',
        describe: 'Detector configuration JSON',
      })
      .option('force', { type: 'boolean', default: false })
      .option('videoStreamIndex', {
        alias: 'video-stream-index',
        type: 'number',
      })
      .option('audioStreamIndex', {
        alias: 'audio-stream-index',
        type: 'number',
      })
      .option('timeoutMs', {
        alias: 'timeout-ms',
        type: 'number',
        default: 14400000,
      })
      .option('threads', { type: 'number', default: 1 })
      .option('acknowledgedBy', {
        alias: 'acknowledged-by',
        type: 'string',
        describe: 'Reviewer identity for qualification',
      })
      .option('acknowledge', {
        type: 'boolean',
        default: false,
        describe: 'Acknowledge review of real held-out episode results',
      }),
  handler: async (args) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      const service = container.get(BreakAnalysisService);
      if (args.action === 'qualify') {
        if (!args.acknowledge || !args.acknowledgedBy?.trim())
          throw new Error(
            'Qualification requires --acknowledge and --acknowledged-by',
          );
        const artifact = EvaluationArtifactSchema.parse(
          await readJson(args.input),
        );
        service.repository.qualify({
          ...qualificationDetails(artifact),
          evaluationHash: createHash('sha256')
            .update(JSON.stringify(artifact))
            .digest('hex'),
          acknowledgedBy: args.acknowledgedBy.trim(),
          createdAt: Date.now(),
        });
        console.log(
          'Detector/configuration qualified. Playback behavior is unchanged.',
        );
        return;
      }
      if (!args.output) throw new Error('--output is required');
      if (args.action === 'report') {
        const input = await readJson(args.input);
        const evaluation = EvaluationArtifactSchema.safeParse(input);
        if (evaluation.success)
          await writeArtifact(args.output, renderEvaluation(evaluation.data));
        else {
          const results = z
            .union([
              BreakAnalysisResultSchema.transform((r) => [r]),
              z.array(BreakAnalysisResultSchema),
            ])
            .parse(input);
          // An unlabeled report must not fabricate false-positive/missed-break metrics.
          const escape = (s: string) =>
            s
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
          await writeArtifact(
            args.output,
            `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="generator" content="Tunarr episode break analysis"><title>Episode break analysis</title><h1>Episode break analysis</h1><p>Unlabeled experimental results. Confidence is not a probability. All timestamps are milliseconds.</p><pre>${escape(JSON.stringify(results, null, 2))}</pre></html>`,
          );
        }
        return;
      }
      const config = BreakDetectorConfigSchema.parse(
        args.config ? await readJson(args.config) : {},
      );
      // Reuse the shared request schema to validate resource limits and overrides.
      const options = {
        ...BreakAnalysisRequestSchema.parse({
          allEpisodes: true,
          config,
          force: args.force,
          videoStreamIndex: args.videoStreamIndex,
          audioStreamIndex: args.audioStreamIndex,
          timeoutMs: args.timeoutMs,
          threads: args.threads,
        }),
        signal: controller.signal,
      };
      if (args.action === 'evaluate') {
        const manifest = BreakEvaluationManifestSchema.parse(
          await readJson(args.input),
        );
        const results: BreakAnalysisResult[] = [];
        for (const episode of manifest.episodes) {
          if (controller.signal.aborted)
            throw new Error('Evaluation cancelled');
          console.log(`Analyzing evaluation episode ${episode.id}`);
          results.push(
            await service.analyzeFile(
              path.resolve(path.dirname(args.input!), episode.path),
              episode.runtimeMs,
              options,
              episode.exclusions,
            ),
          );
        }
        const artifact = makeEvaluation(manifest, results);
        const summary = summarizeEvaluation(artifact);
        await writeArtifact(
          args.output,
          JSON.stringify({ ...artifact, summary }, null, 2),
        );
        await writeArtifact(`${args.output}.html`, renderEvaluation(artifact));
        console.log(
          `Matched ${summary.matches}; false positives ${summary.falsePositives}; missed ${summary.missedBreaks}; failed ${summary.failures}`,
        );
        if (summary.failures) process.exitCode = 1;
      } else if (args.action === 'batch') {
        const request = BreakAnalysisRequestSchema.parse(
          await readJson(args.input),
        );
        const results = await service.batch(request, controller.signal);
        await writeArtifact(args.output, JSON.stringify(results, null, 2));
        if (
          controller.signal.aborted ||
          results.some((r) => r.status !== 'completed')
        )
          process.exitCode = 1;
      } else {
        if (!!args.file === !!args.programId)
          throw new Error('Specify exactly one of --file or --program-id');
        const results = args.file
          ? await service.analyzeFile(
              args.file,
              z.number().int().positive().max(14400000).parse(args.runtimeMs),
              options,
            )
          : await service.batch(
              BreakAnalysisRequestSchema.parse({
                config,
                force: args.force,
                timeoutMs: args.timeoutMs,
                threads: args.threads,
                videoStreamIndex: args.videoStreamIndex,
                audioStreamIndex: args.audioStreamIndex,
                programIds: [args.programId],
              }),
              controller.signal,
            );
        await writeArtifact(args.output, JSON.stringify(results, null, 2));
        if (
          (Array.isArray(results) && results.length === 0) ||
          (Array.isArray(results) ? results : [results]).some(
            (r) => r.status !== 'completed',
          )
        )
          process.exitCode = 1;
      }
    } catch (error) {
      // Only show validation/usage errors; avoid accidental credentials from source failures.
      console.error(
        error instanceof z.ZodError
          ? 'Invalid break-analysis input: check the documented schema.'
          : error instanceof Error && !('code' in error)
            ? error.message
            : 'Break-analysis command failed',
      );
      process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  },
};
