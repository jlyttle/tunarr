import type { FrameSize } from '@/ffmpeg/builder/types.js';
import type { LabelRender, LabelWindow } from '@/stream/musicVideoLabel.js';
import { FilterOption } from './FilterOption.ts';

export type LabelCanvas = {
  displayWidth: number;
  frameSize: FrameSize;
  frameRate: string;
};

const CanvasHeight = 480;
const LeftEdge = 64;
const BottomBaseline = 432;
const LineHeight = 24;
const FontSize = 20;
const FadeSeconds = 0.5;

function escapeOptionValue(value: string) {
  return value.replace(/[\\':]/g, '\\$&');
}

function escapeGraphValue(value: string) {
  return value.replace(/[\\'[\],;]/g, '\\$&');
}

export function escapeDrawtextValue(value: string) {
  return escapeGraphValue(escapeOptionValue(value));
}

function seconds(value: number) {
  return String(Number(value.toFixed(3)));
}

function enableExpression(windows: LabelWindow[]) {
  return windows
    .map(([start, end]) => `between(t,${seconds(start)},${seconds(end)})`)
    .join('+');
}

function fadeExpression(windows: LabelWindow[]) {
  return windows
    .map(
      ([start, end]) =>
        `clip(min(t-${seconds(start)},${seconds(end)}-t)/${FadeSeconds},0,1)`,
    )
    .join('+');
}

export class MusicVideoLabelFilter extends FilterOption {
  public readonly filter: string;

  constructor(
    private label: LabelRender,
    private canvas: LabelCanvas,
    private clockOffsetSeconds: number = 0,
  ) {
    super();
    this.filter = this.generateFilter();
  }

  private generateFilter() {
    const windows = this.label.windows.map(
      ([start, end]): LabelWindow => [
        start + this.clockOffsetSeconds,
        end + this.clockOffsetSeconds,
      ],
    );
    const enable = enableExpression(windows);
    const alpha = fadeExpression(windows);
    const { displayWidth, frameSize, frameRate } = this.canvas;

    const canvasChain = [
      `color=c=black@0:s=${displayWidth}x${CanvasHeight}:r=${frameRate}`,
      'format=yuva420p',
      ...(this.clockOffsetSeconds > 0
        ? [`setpts=PTS+${seconds(this.clockOffsetSeconds)}/TB`]
        : []),
      ...this.label.lines.map((line, index) =>
        this.drawLine(line, this.baseline(index), alpha, enable),
      ),
      `scale=${frameSize.width}:${frameSize.height}`,
    ].join(',');

    return `null[mvlv];${canvasChain}[mvlt];[mvlv][mvlt]overlay=shortest=1:enable='${enable}'`;
  }

  private baseline(index: number) {
    const linesBelow = this.label.lines.length - 1 - index;
    return BottomBaseline - linesBelow * LineHeight;
  }

  private drawLine(
    line: string,
    baseline: number,
    alpha: string,
    enable: string,
  ) {
    return [
      `drawtext=fontfile=${escapeDrawtextValue(this.label.fontFile)}`,
      'expansion=none',
      `text=${escapeDrawtextValue(line)}`,
      `fontsize=${FontSize}`,
      'fontcolor=white',
      'shadowcolor=black@0.8',
      'shadowx=2',
      'shadowy=2',
      `x=${LeftEdge}`,
      `y=${baseline}-ascent`,
      `alpha='${alpha}'`,
      `enable='${enable}'`,
    ].join(':');
  }
}
