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
import './commands/doctor';
import './commands/lang';
import './commands/list';
import './commands/new';
import './commands/outdir';
import './commands/rename';
import './commands/update';
import './commands/watch';
import './commands/migrate';
import './commands/modconfig';
import './commands/modinfo';
import { helpCmd } from './commands/help';
import { setInvocationOptions } from './args';
import {
    parseArgv,
    normalizeLegacyInvocation,
    validateInvocation,
    CliUsageError,
    ValidInvocation,
} from './parser';
import {
    setTemplateTransport,
    GitTransport,
    FetchTransport,
} from './transport';
import { error, info, log, warn, verbose } from './logger';
import { projectDir, migrateStoreDirIfNeeded } from './helper';
import { migrateGlobalConfigIfNeeded } from './templateManager';

// Backward-compatible re-exports: flags used to live here and external
// code (tests, templates) may import them from this module.
export { hasFlag, extractFlag } from './args';
export { CliUsageError } from './parser';

import { setQuiet, setVerbose, setDebug } from './logger';

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
    // Handle SIGINT for clean cleanup (process-level, not invocation-level)
    if (process.listenerCount('SIGINT') === 0) {
        process.on('SIGINT', () => {
            log('\n');
            warn('Process interrupted by user (SIGINT).');
            process.exitCode = 130;
        });
    }

    try {
        // ---- Parse phase (pure: no side effects, no output besides usage) ----
        // The legacy embedded shape runCLI(cmd, args, {flags}) converges onto
        // the same ParsedInvocation the executable path produces, then both
        // go through the same semantic validation (CLI-1 contract).
        let invocation;
        if (cmdName !== undefined || options?.flags !== undefined) {
            invocation = normalizeLegacyInvocation(
                cmdName,
                cmdArgs,
                options?.flags,
            );
        } else {
            const parsed = await parseArgv(process.argv.slice(2), version);
            if (parsed.kind === 'terminal') {
                // --version (or Commander help control flow) already printed
                // through CliIO; nothing left to execute.
                return;
            }
            invocation = parsed.invocation;
        }
        const valid = validateInvocation(invocation);

        // ---- Execute phase ----
        await executeInvocation(valid);
    } catch (e) {
        if (e instanceof CliUsageError) {
            if (!e.alreadyReported) {
                error(e);
            }
            throw e;
        }
        error(e);
        // Rethrow instead of process.exit(): this is a library entry point
        // (the VS Code extension bundles and calls it in-process). The bin
        // entry (src/index.ts) is responsible for setting the exit code.
        throw e;
    }

    log('\n');
}

async function executeInvocation(valid: ValidInvocation): Promise<void> {
    const options = valid.options;

    // Global option wiring (from the parsed invocation, never process.argv).
    // --debug implies verbose; --quiet suppresses non-essential stderr
    // (info/verbose); errors and warnings always print. setDebug gates the
    // stack trace of unexpected errors in the runCLI catch path.
    setVerbose(options.verbose === true || options.debug === true);
    setQuiet(options.quiet === true);
    setDebug(options.debug === true);
    if (typeof options.transport === 'string') {
        setTemplateTransport(
            options.transport === 'git'
                ? new GitTransport()
                : new FetchTransport(),
        );
    }

    // Help and the no-command banner are pure invocations: no migrations,
    // no config creation, no project discovery, no template resolution.
    if (options.help === true) {
        await helpCmd(valid.command?.name);
        return;
    }
    if (!valid.command) {
        printBanner();
        await helpCmd();
        return;
    }

    // The help command is display-only: like the --help flag it must stay a
    // pure invocation (no migrations, no config creation, no discovery).
    if (valid.command.name === 'help') {
        await helpCmd(valid.positionals[0]);
        return;
    }

    // Real command: run store/config migrations before dispatch, then hand
    // the parsed invocation to the command handler (business logic unchanged).
    migrateStoreDirIfNeeded();
    migrateGlobalConfigIfNeeded();

    log('\n');

    verbose('Project Dir:  ' + projectDir());
    verbose(
        `Executing command [${valid.command.name}] ${valid.positionals.length ? `with params [${valid.positionals.join(', ')}]` : ''}`,
    );

    setInvocationOptions(options);
    try {
        await valid.command.run({
            positionals: valid.positionals,
            options: valid.options,
        });
        if (!valid.command.silent) {
            info(`Command [${valid.command.name}] completed.`);
        }
    } finally {
        setInvocationOptions(undefined);
    }
}

function printBanner(): void {
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
    log(`Project Zomboid Studio v${version} - @${branch} (${buildDate})\n`);
}
