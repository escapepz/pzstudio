import { basename, join, resolve } from 'path';
import {
    existsSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'fs';
import { strToU8, zipSync } from 'fflate';
import { expect } from '../expect';
import { CliError } from '../errors';
import { CliUsageError } from '../parser';
import { addHelp } from '../help';
import { registerCommand, type CommandContext } from '../registry';
import { engineIo, info, log, verbose } from '../logger';
import { printJsonEnvelope } from '../json';
import {
    getConfigDir,
    readGlobalConfig,
    writeGlobalConfig,
} from '../templateManager';
import { resetUsageRecorder } from '../usage';

addHelp(
    'usage',
    `Manage the local usage logs (on | off | status | export).

    Usage logging is on by default and stays entirely on this machine: one
    NDJSON event per command in ~/.pzstudio/usage, never uploaded.

    Usages:
        pzstudio usage on                    - Enable local usage logging.
        pzstudio usage off [--purge]         - Disable local usage logging; add --purge to also delete the log directory.
        pzstudio usage status                - Show where the logs live and what they contain.
        pzstudio usage export [--out <file>] - Bundle the logs into a zip for inspection or sharing.
        pzstudio usage export --json         - Print a machine-readable envelope instead of the human report.

    Flags:
        --purge        - With 'off' only: delete ~/.pzstudio/usage entirely (ignored with the other actions).
        --out <value>  - With 'export': write the zip to this path instead of pzstudio-usage-<date>.zip in the current directory.
        --json         - With 'export': print the v1 JSON envelope (schemaVersion/command/result) on stdout; the zip is still written (--out honored).`,
);

const USAGE_DIR_NAME = 'usage';
const EVENTS_FILE_PATTERN = /^events-.*\.ndjson$/;

interface UsageSummary {
    fileCount: number;
    totalBytes: number;
    eventCount: number;
    sessionCount: number;
    skippedLines: number;
    dateRange: { from: string; to: string } | null;
}

function usageLogDir(): string {
    return join(getConfigDir(), USAGE_DIR_NAME);
}

function eventFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => EVENTS_FILE_PATTERN.test(name))
        .sort()
        .map((name) => join(dir, name));
}

function summarizeStore(dir: string): UsageSummary {
    const sessions = new Set<string>();
    const stamps: string[] = [];
    let eventCount = 0;
    let skippedLines = 0;
    let totalBytes = 0;
    const files = eventFiles(dir);
    for (const file of files) {
        totalBytes += statSync(file).size;
        for (const raw of readFileSync(file, 'utf-8').split('\n')) {
            const line = raw.trim();
            if (!line) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                skippedLines += 1;
                continue;
            }
            if (
                typeof parsed !== 'object' ||
                parsed === null ||
                Array.isArray(parsed)
            ) {
                skippedLines += 1;
                continue;
            }
            eventCount += 1;
            const event = parsed as Record<string, unknown>;
            if (typeof event.sid === 'string') sessions.add(event.sid);
            if (typeof event.ts === 'string') stamps.push(event.ts);
        }
    }
    stamps.sort();
    return {
        fileCount: files.length,
        totalBytes,
        eventCount,
        sessionCount: sessions.size,
        skippedLines,
        dateRange:
            stamps.length > 0
                ? { from: stamps[0], to: stamps[stamps.length - 1] }
                : null,
    };
}

function defaultZipPath(): string {
    const now = new Date();
    const stamp =
        `${now.getFullYear()}` +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0');
    return resolve(`pzstudio-usage-${stamp}.zip`);
}

function usageOn(): void {
    const config = readGlobalConfig(true, engineIo());
    config.usageLog = { ...config.usageLog, enabled: true };
    writeGlobalConfig(config);
    resetUsageRecorder();
    log('Usage logging is enabled.');
}

function usageOff(purge: boolean): void {
    const config = readGlobalConfig(true, engineIo());
    config.usageLog = { ...config.usageLog, enabled: false };
    writeGlobalConfig(config);
    resetUsageRecorder();
    if (purge) {
        rmSync(usageLogDir(), { recursive: true, force: true });
        log(
            'Usage logging is disabled. The usage log directory has been purged.',
        );
        return;
    }
    log(
        'Usage logging is disabled. Existing logs are kept; delete them with pzstudio usage off --purge.',
    );
}

function usageStatus(): void {
    const config = readGlobalConfig(true, engineIo());
    const enabled = config.usageLog?.enabled !== false;
    const dir = usageLogDir();
    const summary = summarizeStore(dir);
    log(`Usage logging is ${enabled ? 'enabled' : 'disabled'}.`);
    log(`Usage log directory: ${dir}`);
    log(`Files: ${summary.fileCount} (${summary.totalBytes} bytes)`);
    log(
        `Events: ${summary.eventCount} across ${summary.sessionCount} session(s)`,
    );
    log(
        `Date range: ${summary.dateRange ? `${summary.dateRange.from} .. ${summary.dateRange.to}` : 'none'}`,
    );
}

function usageExport(options: CommandContext['options']): void {
    const out = options.out;
    expect('flag [--out]', out, 'string|undefined');
    const outOverride =
        typeof out === 'string' && out.length > 0 ? out : undefined;
    const dir = usageLogDir();
    if (eventFiles(dir).length === 0) {
        throw new CliError('No usage logs to export.', {
            tryHint:
                'Usage logs accumulate as you run pzstudio commands (logging is on by default); try again after using the CLI.',
        });
    }
    const summary = summarizeStore(dir);
    const manifest = {
        schemaV: 1,
        generatedAt: new Date().toISOString(),
        dateRange: summary.dateRange,
        sessionCount: summary.sessionCount,
        eventCount: summary.eventCount,
        skippedLines: summary.skippedLines,
    };
    const bundle: Record<string, Uint8Array> = {
        'manifest.json': strToU8(JSON.stringify(manifest, null, 4) + '\n'),
    };
    for (const file of eventFiles(dir)) {
        bundle[basename(file)] = readFileSync(file);
    }
    const outPath = outOverride ? resolve(outOverride) : defaultZipPath();
    try {
        writeFileSync(outPath, zipSync(bundle));
    } catch {
        throw new CliError(`Failed to write the usage bundle to ${outPath}.`, {
            tryHint:
                'Check that the directory exists and that the path is writable.',
        });
    }
    if (options.json === true) {
        printJsonEnvelope('usage', {
            action: 'export',
            outPath,
            fileCount: summary.fileCount,
            totalBytes: summary.totalBytes,
            eventCount: summary.eventCount,
            sessionCount: summary.sessionCount,
            skippedLines: summary.skippedLines,
            dateRange: summary.dateRange,
        });
        return;
    }
    log(
        `Exported ${summary.eventCount} event(s) across ${summary.sessionCount} session(s) from ${summary.fileCount} file(s) to ${outPath}`,
    );
    if (summary.skippedLines > 0) {
        log(`Skipped ${summary.skippedLines} unparseable line(s).`);
    }
    if (summary.eventCount === 0 && summary.skippedLines > 0) {
        log(
            'Warning: the store contained only unparseable lines — no valid events were exported.',
        );
    }
    verbose(`Usage bundle written: ${outPath}`);
}

export function usageCmd(
    action: string,
    options: CommandContext['options'] = {},
): void {
    expect('param [action]', action, 'string');

    verbose(`Managing usage logs: ${action}`);

    if (options.purge === true && action !== 'off') {
        info(
            `- --purge is ignored unless the action is 'off' (this ${action} does not purge).`,
        );
    }

    switch (action) {
        case 'on':
            usageOn();
            return;
        case 'off':
            usageOff(options.purge === true);
            return;
        case 'status':
            usageStatus();
            return;
        case 'export':
            usageExport(options);
            return;
        default:
            throw new CliUsageError(
                `Unknown usage action '${action}' (expected one of: on, off, status, export).`,
            );
    }
}

registerCommand({
    name: 'usage',
    summary: 'Manage local usage logs (on | off | status | export).',
    positionals: [{ name: 'action', required: true }],
    flags: [
        { name: 'purge' },
        { name: 'out', takesValue: true },
        { name: 'json' },
    ],
    run: (ctx) => usageCmd(ctx.positionals[0], ctx.options),
});
