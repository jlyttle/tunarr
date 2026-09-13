import { inject, injectable } from 'inversify';
import { VideoScanDetectionService } from '../services/VideoScanDetectionService.ts';
import { SimpleTask } from './Task.ts';
import { simpleTaskDef } from './TaskRegistry.ts';

@injectable()
@simpleTaskDef({
  description:
    'Detect Missing Interlace Metadata: probe unknown video scan types without changing channel programming',
})
export class DetectMissingInterlaceMetadataTask extends SimpleTask {
  constructor(
    @inject(VideoScanDetectionService)
    private readonly detection: VideoScanDetectionService,
  ) {
    super();
  }

  protected async runInternal() {
    await this.detection.detectMissing();
  }
}
