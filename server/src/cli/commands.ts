import { GenerateOpenApiCommand } from './GenerateOpenApiCommand.ts';
import { BreakAnalysisCommand } from './BreakAnalysisCommand.ts';
import { RunServerCommand } from './RunServerCommand.ts';
import { StartWorkerCommand } from './StartWorkerCommand.ts';
import { databaseCommands } from './database/databaseCommands.ts';
import { RunFixerCommand } from './runFixerCommand.ts';
import { settingsCommands } from './settings/settingsCommands.ts';

export const commands = [
  BreakAnalysisCommand,
  settingsCommands,
  RunFixerCommand,
  RunServerCommand,
  databaseCommands,
  GenerateOpenApiCommand,
  StartWorkerCommand,
];
