/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore - necessary because we can't reliably predict if typescript will resolve this outside src without structural errors in some configs
import { version, branch } from '../../package.json';
/* eslint-enable @typescript-eslint/ban-ts-comment */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
// Command files self-register into the registry at import time.
import './commands/add';
import './commands/build';
import './commands/clean';
import './commands/delete';
import './commands/lang';
import './commands/list';
import './commands/new';
import './commands/outdir';
import './commands/rename';
import './commands/update';
import './commands/watch';
import './commands/migrate';
import './commands/modinfo';
import { helpCmd } from './commands/help';
import {
    cmd,
    processArgs,
    splitArgs,
    setProcessArgsOverride,
    hasFlag,
    extractFlag,
} from './args';
import { getCommand } from './registry';
import {
    setTemplateTransport,
    GitTransport,
    FetchTransport,
} from './transport';
import { clear, error, info, log, warn, verbose } from './logger';
import { projectDir, migrateStoreDirIfNeeded } from './helper';
import { migrateGlobalConfigIfNeeded } from './templateManager';

// Backward-compatible re-exports: flags used to live here and external
// code (tests, templates) may import them from this module.
export { hasFlag, extractFlag } from './args';

import { setVerbose } from './logger';

export interface RunCLIOptions {
    /**
     * Flags to use instead of process.argv (e.g. ['--verbose', '--path', 'C:\\dir']).
     * Lets API callers pass flags without mutating process.argv.
     */
    flags?: string[];
}

export async function runCLI(
    cmdName?: string,
    cmdArgs?: string[],
    options?: RunCLIOptions,
) {
    if (options?.flags) {
        setProcessArgsOverride([
            cmdName ?? '',
            ...(cmdArgs ?? []),
            ...options.flags,
        ]);
    }

    // Handle SIGINT for clean cleanup
    if (process.listenerCount('SIGINT') === 0) {
        process.on('SIGINT', () => {
            log('\n');
            warn('Process interrupted by user (SIGINT).');
            process.exitCode = 130;
        });
    }

    // Initialize verbose mode early
    if (hasFlag('verbose')) {
        setVerbose(true);
    }

    // Transport override: 'git' or 'fetch' (default: git when available)
    const transportFlag = extractFlag('transport');
    if (transportFlag === 'git' || transportFlag === 'fetch') {
        setTemplateTransport(
            transportFlag === 'git' ? new GitTransport() : new FetchTransport(),
        );
    } else if (transportFlag !== undefined) {
        throw new Error(
            `Invalid --transport value '${transportFlag}' (expected 'git' or 'fetch').`,
        );
    }

    try {
        // Handle root-level help and version (side-effect free)
        if (hasFlag('version')) {
            log(`v${version}`);
            return;
        }

        // Migrate legacy store and config on first CLI call
        migrateStoreDirIfNeeded();
        migrateGlobalConfigIfNeeded();

        clear();
        log('\n');

        let buildDate = 'Unknown';
        try {
            const buildInfoPath = join(__dirname, '../build.json');
            if (existsSync(buildInfoPath)) {
                buildDate =
                    JSON.parse(readFileSync(buildInfoPath, 'utf8')).buildDate ??
                    'Unknown';
            }
        } catch (_e) {
            // ignore
        }

        const currentCmd = cmdName ?? cmd();

        if (!currentCmd) {
            log(
                `Project Zomboid Studio v${version} - @${branch} (${buildDate})\n`,
            );
        }

        if (hasFlag('help') && !currentCmd) {
            await helpCmd();
            return;
        }

        const rawCmdArgs = cmdArgs ?? processArgs().slice(1);
        const { positionals } = splitArgs(rawCmdArgs);
        // Positional args are kept as strings: mod ids like "12345" must not
        // be coerced to numbers (ArgTypeError in expect()).
        const commandParams: string[] = positionals;

        const registered = currentCmd ? getCommand(currentCmd) : undefined;

        verbose('Project Dir:  ' + projectDir());

        verbose(
            `Executing command [${currentCmd}] ${commandParams.length ? `with params [${commandParams.join(', ')}]` : ''}`,
        );

        // Handle --help for specific command BEFORE executing it (allows help even outside projects)
        if (hasFlag('help') && currentCmd) {
            await helpCmd(currentCmd);
            return;
        }

        if (currentCmd === undefined) {
            await helpCmd();
        } else if (registered) {
            await registered.run({ positionals: commandParams });
            if (!registered.silent) {
                info(`Command [${registered.name}] completed.`);
            }
        } else {
            throw new Error(`Unknown command [${currentCmd}]`);
        }
    } catch (e) {
        error(e);
        // Rethrow instead of process.exit(): this is a library entry point
        // (the VS Code extension bundles and calls it in-process). The bin
        // entry (src/index.ts) is responsible for setting the exit code.
        throw e;
    } finally {
        if (options?.flags) {
            setProcessArgsOverride(undefined);
        }
    }

    log('\n');
}
