import { BreakAnalysisRequestSchema } from '@tunarr/types/schemas';
import { inject, injectable } from 'inversify';
import { BreakAnalysisService } from '../services/break-analysis/BreakAnalysisService.ts';
import { Task2 } from './Task.ts';
import { taskDef } from './TaskRegistry.ts';

@injectable()
@taskDef({
  schema: BreakAnalysisRequestSchema,
  description:
    'Offline experimental episode break analysis (explicit selections only)',
})
export class AnalyzeEpisodeBreaksTask extends Task2<
  typeof BreakAnalysisRequestSchema,
  Awaited<ReturnType<BreakAnalysisService['batch']>>
> {
  readonly ID = 'AnalyzeEpisodeBreaksTask';
  readonly schema = BreakAnalysisRequestSchema;
  constructor(
    @inject(BreakAnalysisService)
    private readonly analysis: BreakAnalysisService,
  ) {
    super();
  }
  protected runInternal(request: Parameters<BreakAnalysisService['batch']>[0]) {
    return this.analysis.batch(request);
  }
}
