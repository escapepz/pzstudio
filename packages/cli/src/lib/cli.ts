/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore - necessary because we can't reliably predict if typescript will resolve this outside src without structural errors in some configs
import { version, branch } from '../../package.json';
/* eslint-enable @typescript-eslint/ban-ts-comment */
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
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
import { error, info, log, verbose } from './logger';
import {
    discoveryStartDir,
    findProjectDir,
    migrateStoreDirIfNeeded,
    setProjectRootAnchor,
} from './helper';
import { migrateGlobalConfigIfNeeded } from './templateManager';
import { setInteractionMode } from './interaction';

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
    // No process-level SIGINT handler here (CLI-6): long-running commands
    // own their interruption (watch cleans up and stops with exit 130);
    // everything else keeps Node's default signal termination. A global
    // handler would also leak into embedded hosts and double-report on
    // Ctrl+C alongside the command's own handler.
    try {
        // CLI-9: the interaction policy is decided once per invocation from
        // the invocation shape — never by command handlers. The legacy
        // embedded shape is the library boundary (VS Code extension): it
        // must never terminal-prompt. The executable prompts only on a real
        // TTY; anything else (pipes, CI) refuses destructive actions.
        setInteractionMode(
            cmdName !== undefined || options?.flags !== undefined
                ? 'embedded'
                : process.stdout.isTTY
                  ? 'interactive'
                  : 'non-interactive',
        );
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
    // -C/--project anchors project discovery (CLI-5): it replaces the
    // discovery start for this invocation without mutating process.cwd().
    // Passing no --project clears the anchor (embedded hosts re-invoke).
    setProjectRootAnchor(
        typeof options.project === 'string'
            ? resolve(options.project)
            : undefined,
    );
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

    // Diagnostic only — non-throwing discovery so commands that legitimately
    // run outside a project (new, migrate) never fail on this log line.
    verbose('Project Dir:  ' + (findProjectDir() ?? discoveryStartDir()));
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
        // build.json lives in dist/ next to the runtime. The esbuild bundle
        // sits at dist/index.js (co-located); the tsc layout emits
        // dist/lib/cli.js with build.json one level up.
        const candidates = [
            join(__dirname, 'build.json'),
            join(__dirname, '../build.json'),
        ];
        const buildInfoPath = candidates.find((p) => existsSync(p));
        if (buildInfoPath) {
            buildDate =
                JSON.parse(readFileSync(buildInfoPath, 'utf8')).buildDate ??
                'Unknown';
        }
    } catch (_e) {
        // ignore
    }
    log(`Project Zomboid Studio v${version} - @${branch} (${buildDate})\n`);
}
