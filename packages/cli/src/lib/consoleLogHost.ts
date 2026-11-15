/**
 * Host adapter for the console.txt analyzer (AGENTS.md: the CLI owns the
 * host-side filesystem). The engine in @pzstudio/core is browser-safe and
 * takes an injected ProjectFileSystem; this module wires it to the real
 * filesystem and to the open CLI project's mod sources.
 */
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

/**
 * Analyzes a Project Zomboid console.txt session through the Node
 * filesystem. Without an explicit path the game's default log location is
 * used (`<home>/Zomboid/console.txt`); a locked or missing file resolves as
 * a report with `log.readError` set — never a throw.
 */
export async function analyzeGameLogFile(
    logPath: string | undefined,
    context?: ConsoleLogProjectContext,
    options?: AnalyzeConsoleLogOptions,
): Promise<ConsoleLogReport> {
    const path = logPath ?? join(homedir(), 'Zomboid', 'console.txt');
    return analyzeConsoleLog(new NodeFileSystem(), path, context, options);
}

/**
 * Builds the attribution context from a CLI project: each mod in
 * project.json maps to `{ modId, displayName: mod.name, sourceRootUri }`
 * with the mod's source root at `<project>/<modId>/` (the layout add/new
 * scaffold). Returns undefined when the project config is missing; a
 * present-but-invalid config throws (callers decide whether that is fatal).
 */
export function buildProjectContext(
    projectPath: string,
): ConsoleLogProjectContext | undefined {
    // readProjectConfig takes the config FILE path (helper.ts), not the
    // project dir — same composition as lib/doctor.ts.
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
