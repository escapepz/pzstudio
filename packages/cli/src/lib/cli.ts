/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore - necessary because we can't reliably predict if typescript will resolve this outside src without structural errors in some configs
import { version } from '../../package.json';
/* eslint-enable @typescript-eslint/ban-ts-comment */
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import './commands/add';
import './commands/build';
import './commands/clean';
import './commands/delete';
import './commands/doctor';
import './commands/lang';
import './commands/list';
import './commands/logs';
import './commands/new';
import './commands/outdir';
import './commands/rename';
import './commands/update';
import './commands/watch';
import './commands/migrate';
import './commands/modconfig';
import './commands/modinfo';
import './commands/usage';
import './commands/workshop-vdf';
import { helpCmd } from './commands/help';
import { setInvocationOptions } from './args';
import {
    parseArgv,
    normalizeLegacyInvocation,
    validateInvocation,
    CliUsageError,
    ValidInvocation,
    type ParsedInvocation,
} from './parser';
import {
    setTemplateTransport,
    legacyTransport,
    GitTransport,
    FetchTransport,
    type TemplateTransport,
} from './transport';
import {
    error,
    info,
    log,
    verbose,
    legacyLogger,
    engineIo,
    setQuiet,
    setVerbose,
    setDebug,
} from './logger';
import {
    discoveryStartDir,
    findProjectDir,
    getExternalProjectDir,
    legacySettings,
    migrateStoreDirIfNeeded,
    setProjectRootAnchor,
} from './helper';
import { migrateGlobalConfigIfNeeded } from './templateManager';
import { setInteractionMode } from './interaction';
import {
    installInvocationContext,
    withEngineLock,
    type InteractionMode,
    type InvocationContext,
    type InvocationInputs,
} from './invocation';
import { recordUsageSpan } from './usage';

export { hasFlag, extractFlag } from './args';
export { CliUsageError } from './parser';

export interface RunCLIOptions {
    flags?: string[];
}

export interface LifecycleFacade {
    resolveSettings(invocation: ParsedInvocation, ctx: InvocationContext): void;
    writeInteractionMode(mode: InteractionMode): void;
    writeVerbosity(verbose: boolean, quiet: boolean, debug: boolean): void;
    writeAnchor(anchor: string | undefined): void;
    writeStickyTransport(transport: TemplateTransport): void;
    writeInvocationOptions(
        options: Record<string, string | boolean | undefined> | undefined,
    ): void;
}

const legacyFacade: LifecycleFacade = {
    resolveSettings: (_invocation, ctx) => {
        ctx.settings = legacySettings();
    },
    writeInteractionMode: (mode) => setInteractionMode(mode),
    writeVerbosity: (verbose, quiet, debug) => {
        setVerbose(verbose);
        setQuiet(quiet);
        setDebug(debug);
    },
    writeAnchor: (anchor) => setProjectRootAnchor(anchor),
    writeStickyTransport: (transport) => setTemplateTransport(transport),
    writeInvocationOptions: (options) => setInvocationOptions(options),
};

export async function runCLI(
    cmdName?: string,
    cmdArgs?: string[],
    options?: RunCLIOptions,
) {
    const inputs: InvocationInputs = {
        logger: legacyLogger(),
        templateTransport: legacyTransport(),
        projectDir: getExternalProjectDir(),
        interactionMode:
            cmdName !== undefined || options?.flags !== undefined
                ? 'embedded'
                : process.stdout.isTTY
                  ? 'interactive'
                  : 'non-interactive',
    };

    return withEngineLock(async () => {
        const installed = installInvocationContext(inputs);
        try {
            return await runInvocationLifecycle(
                cmdName,
                cmdArgs,
                options,
                installed.context,
                legacyFacade,
            );
        } finally {
            installed.restore();
        }
    });
}

export async function runInvocationLifecycle(
    cmdName: string | undefined,
    cmdArgs: string[] | undefined,
    options: RunCLIOptions | undefined,
    ctx: InvocationContext,
    facade: LifecycleFacade,
): Promise<void> {
    try {
        facade.writeInteractionMode(ctx.interactionMode);
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
                return;
            }
            invocation = parsed.invocation;
        }
        facade.resolveSettings(invocation, ctx);
        const valid = validateInvocation(invocation);

        const helpOnly =
            !valid.command ||
            valid.options['help'] === true ||
            valid.command.name === 'help';
        if (helpOnly) {
            await executeInvocation(valid, ctx, facade);
        } else {
            await recordUsageSpan(valid.command.name, ctx, () =>
                executeInvocation(valid, ctx, facade),
            );
        }
    } catch (e) {
        if (e instanceof CliUsageError) {
            if (!e.alreadyReported) {
                error(e);
            }
            throw e;
        }
        error(e);
        throw e;
    }

    log('\n');
}

async function executeInvocation(
    valid: ValidInvocation,
    ctx: InvocationContext,
    facade: LifecycleFacade,
): Promise<void> {
    const options = valid.options;

    ctx.verbose = options.verbose === true || options.debug === true;
    ctx.quiet = options.quiet === true;
    ctx.debug = options.debug === true;
    facade.writeVerbosity(ctx.verbose, ctx.quiet, ctx.debug);
    const anchor =
        typeof options.project === 'string'
            ? resolve(options.project)
            : undefined;
    ctx.anchor = anchor ?? ctx.projectDir;
    facade.writeAnchor(anchor);
    if (typeof options.transport === 'string') {
        const transport =
            options.transport === 'git'
                ? new GitTransport(engineIo())
                : new FetchTransport(engineIo());
        ctx.templateTransport = transport;
        facade.writeStickyTransport(transport);
    }

    if (options.help === true) {
        await helpCmd(valid.command?.name);
        return;
    }
    if (!valid.command) {
        printBanner();
        await helpCmd();
        return;
    }

    if (valid.command.name === 'help') {
        await helpCmd(valid.positionals[0]);
        return;
    }

    migrateStoreDirIfNeeded();
    migrateGlobalConfigIfNeeded();

    log('\n');

    verbose('Project Dir:  ' + (findProjectDir() ?? discoveryStartDir()));
    verbose(
        `Executing command [${valid.command.name}] ${valid.positionals.length ? `with params [${valid.positionals.join(', ')}]` : ''}`,
    );

    ctx.invocationOptions = options;
    facade.writeInvocationOptions(options);
    try {
        await valid.command.run({
            positionals: valid.positionals,
            options: valid.options,
        });
        if (!valid.command.silent) {
            info(`Command [${valid.command.name}] completed.`);
        }
    } finally {
        ctx.invocationOptions = {};
        facade.writeInvocationOptions(undefined);
    }
}

function printBanner(): void {
    let buildDate = 'Unknown';
    try {
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
    } catch (_e) {}
    log(`Project Zomboid Studio v${version} (${buildDate})\n`);
}
