import { homedir } from 'os';
import { join } from 'path';
import { NodeFileSystem } from '@pzstudio/platform-node';
import { analyzeConsoleLog } from '@pzstudio/core';
import type {
    AnalyzeConsoleLogOptions,
    ConsoleLogProjectContext,
    ConsoleLogReport,
} from '@pzstudio/core';
import { readProjectConfig } from './helper';

export async function analyzeGameLogFile(
    logPath: string | undefined,
    context?: ConsoleLogProjectContext,
    options?: AnalyzeConsoleLogOptions,
): Promise<ConsoleLogReport> {
    const path = logPath ?? join(homedir(), 'Zomboid', 'console.txt');
    return analyzeConsoleLog(new NodeFileSystem(), path, context, options);
}

export function buildProjectContext(
    projectPath: string,
): ConsoleLogProjectContext | undefined {
    const config = readProjectConfig(join(projectPath, 'project.json'));
    if (!config) {
        return undefined;
    }
    const mods = Object.entries(config.mods).map(([modId, mod]) => ({
        modId,
        displayName: mod.name,
        sourceRootUri: join(projectPath, modId),
    }));
    return { mods };
}
