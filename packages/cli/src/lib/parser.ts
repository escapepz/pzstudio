/**
 * Commander adapter — parser/help infrastructure ONLY.
 *
 * Layer contract (CLI-1):
 *   bin/index.ts          sets process.exitCode, nothing else
 *   this adapter          parse/help/usage validation -> ParsedInvocation
 *   lib/cli.ts            execution context, migrations, dispatch
 *   lib/commands/*        business logic (untouched by parsing)
 *
 * Commander MUST NOT own the process lifecycle: it never exits the process,
 * never writes without going through CliIO, and its action handlers are
 * capture-only (they never invoke command business logic).
 */
import { Command, CommanderError, Option } from 'commander';

// Re-exported so tests/embedders can classify without importing commander
// directly (commander resolves from the cli package, not the repo root).
export { CommanderError };
import {
    allCommands,
    getCommand,
    CommandDef,
    FlagSpec,
    GLOBAL_FLAGS,
    PositionalSpec,
} from './registry';

/** Raw output sink. Commander output flows through here, never the logger. */
export interface CliIO {
    stdout(text: string): void;
    stderr(text: string): void;
}

const processIO: CliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
};

let activeIO: CliIO = processIO;

/**
 * Replaces the output sink (test hook). Pass undefined to restore the
 * process streams. Command output always goes through CliIO so tests and
 * embedders can capture usage output without touching the logger.
 */
export function setCliIO(sink: CliIO | undefined): void {
    activeIO = sink ?? processIO;
}

export function getCliIO(): CliIO {
    return activeIO;
}

/** An invocation produced by parsing, before semantic validation. */
export interface ParsedInvocation {
    /** Raw command name as typed (undefined when no command was given). */
    commandName?: string;
    /** Resolved command definition (undefined when unknown or not given). */
    command?: CommandDef;
    positionals: string[];
    /** Dash-case option name -> boolean flag or string value. */
    options: Record<string, string | boolean | undefined>;
    /** Tokens rejected while structuring (legacy path); validated later. */
    unknownOptions?: string[];
}

/** A ParsedInvocation that passed validateInvocation(). */
export type ValidInvocation = ParsedInvocation & {
    command: CommandDef;
};

/**
 * Usage-level failure (bad syntax, unknown command/flag, arity). Exit code 2.
 * `alreadyReported` marks errors whose text was already printed by Commander;
 * the caller must not log them a second time.
 */
export class CliUsageError extends Error {
    readonly alreadyReported: boolean;

    constructor(message: string, alreadyReported = false) {
        super(message);
        this.name = 'CliUsageError';
        this.alreadyReported = alreadyReported;
    }
}

type ControlFlowKind = 'help' | 'version' | 'usage';

/**
 * Maps a Commander control-flow error to CLI semantics by its `code` —
 * never by `err.exitCode` (that is Commander's own process-exit convention,
 * which we deliberately do not follow).
 *
 * Contract tests pin the codes emitted by the pinned commander version; a
 * library upgrade that changes codes must update this switch explicitly.
 */
export function classifyCommanderError(err: unknown): {
    kind: ControlFlowKind;
    message?: string;
} {
    if (err instanceof CommanderError) {
        switch (err.code) {
            case 'commander.version':
                return { kind: 'version' };
            case 'commander.help':
            case 'commander.helpDisplayed':
                return { kind: 'help' };
            default:
                return { kind: 'usage', message: err.message };
        }
    }
    throw err;
}

function camelCase(name: string): string {
    return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function addFlag(cmd: Command, flag: FlagSpec): void {
    const value = flag.takesValue ? ' <value>' : '';
    const long = `--${flag.name}${value}`;
    const token = flag.short ? `-${flag.short}, ${long}` : long;
    const opt = new Option(token, flag.name);
    if (flag.choices) {
        opt.choices([...flag.choices]);
    }
    cmd.addOption(opt);
}

function addPositional(cmd: Command, spec: PositionalSpec): void {
    // Declared optional on the Commander side ON PURPOSE: required/arity
    // semantics are enforced by validateInvocation() so the executable and
    // embedded paths share ONE validator (Commander only owns syntax).
    // The --help option must short-circuit arity checks on both paths.
    const token = spec.variadic ? `[${spec.name}...]` : `[${spec.name}]`;
    cmd.argument(token);
}

/**
 * Builds the Commander program from the registry. Fresh instance per parse
 * (Commander keeps parse state on the instance). Action handlers are
 * capture-only: they normalize what Commander parsed into a
 * ParsedInvocation and never call business logic.
 */
function buildProgram(version: string): {
    program: Command;
    getInvocation: () => ParsedInvocation | undefined;
} {
    const program = new Command();
    let captured: ParsedInvocation | undefined;

    program
        .name('pzstudio')
        .version(`v${version}`)
        .exitOverride()
        .showSuggestionAfterError(true)
        // Help display is ours: curated texts in lib/help.ts are printed by
        // the dispatcher when the --help option is seen. Disabling
        // Commander's help machinery keeps every output path explicit.
        .helpOption(false)
        .addHelpCommand(false)
        .configureOutput({
            writeOut: (text) => activeIO.stdout(text),
            writeErr: (text) => activeIO.stderr(text),
        });

    // Global flags must be declared on the program too, so they parse in
    // every position (`pzstudio --verbose build` and `pzstudio build
    // --verbose`); subcommand actions merge them via optsWithGlobals().
    for (const flag of GLOBAL_FLAGS) {
        addFlag(program, flag);
    }

    program.action((...cbArgs: unknown[]) => {
        const cmd = cbArgs[cbArgs.length - 1] as Command;
        captured = toInvocation(
            undefined,
            cmd.optsWithGlobals() as Record<string, unknown>,
            [],
        );
    });

    for (const def of allCommands()) {
        const sub = program.command(def.name);
        sub.description(def.summary).helpOption(false);
        for (const flag of GLOBAL_FLAGS) {
            addFlag(sub, flag);
        }
        for (const flag of def.flags ?? []) {
            addFlag(sub, flag);
        }
        for (const spec of def.positionals ?? []) {
            addPositional(sub, spec);
        }
        sub.action((...cbArgs: unknown[]) => {
            const cmd = cbArgs[cbArgs.length - 1] as Command;
            // Global flags are declared on BOTH the program and the
            // subcommand (so they parse in every position); with that
            // shadowing, Commander keeps the parsed values on the parent
            // store — optsWithGlobals() is the only reliable merged view.
            const options = cmd.optsWithGlobals() as Record<string, unknown>;
            // Commander passes undefined for unfilled optional arguments and
            // an array for a trailing variadic. Required positionals always
            // precede optionals (schema rule), so the first undefined marks
            // the end of the provided values.
            const positionals: string[] = [];
            for (const raw of cbArgs.slice(0, -2)) {
                if (raw === undefined) break;
                if (Array.isArray(raw)) {
                    positionals.push(...raw.map(String));
                } else {
                    positionals.push(
                        typeof raw === 'string' ? raw : String(raw),
                    );
                }
            }
            captured = toInvocation(def, options, positionals);
        });
    }

    return { program, getInvocation: () => captured };
}

function toInvocation(
    def: CommandDef | undefined,
    commanderOptions: Record<string, unknown>,
    positionals: string[],
): ParsedInvocation {
    // Commander camelCases option names; our handlers read dash-case via
    // hasFlag/extractFlag. Map every declared flag name back to its value.
    const declared: FlagSpec[] = [...GLOBAL_FLAGS, ...(def?.flags ?? [])];
    const options: Record<string, string | boolean | undefined> = {};
    for (const flag of declared) {
        const value = commanderOptions[camelCase(flag.name)];
        options[flag.name] =
            typeof value === 'string' || typeof value === 'boolean'
                ? value
                : undefined;
    }
    return {
        commandName: def?.name,
        command: def,
        positionals,
        options,
    };
}

export type ParseOutcome =
    | { kind: 'invocation'; invocation: ParsedInvocation }
    /** Control flow already handled during parse (e.g. --version printed). */
    | { kind: 'terminal' };

/**
 * Finds the first token Commander would treat as the command candidate —
 * value-aware: the value of a declared value-flag is skipped, never
 * mistaken for a command. With a root action handler registered, Commander
 * would otherwise report unknown commands as "too many arguments"; this
 * pre-check rejects them with our own usage error first.
 */
function detectCommandCandidate(userArgs: string[]): string | undefined {
    const valueFlags = new Set(
        GLOBAL_FLAGS.filter((f) => f.takesValue).map((f) => f.name),
    );
    const valueShorts = new Set(
        GLOBAL_FLAGS.filter((f) => f.takesValue && f.short).map(
            (f) => f.short as string,
        ),
    );
    for (let i = 0; i < userArgs.length; i++) {
        const token = userArgs[i];
        if (token === '--') {
            break;
        }
        if (token.startsWith('--')) {
            const name = token.slice(2).split('=', 1)[0];
            if (
                valueFlags.has(name) &&
                !token.includes('=') &&
                i + 1 < userArgs.length &&
                !userArgs[i + 1].startsWith('-')
            ) {
                i++;
            }
            continue;
        }
        if (token.startsWith('-')) {
            // Short flag: `-C dir` consumes the next token as its value;
            // `-Cdir` / `-C=dir` carry it inline.
            const short = token[1];
            if (
                valueShorts.has(short) &&
                token.length === 2 &&
                i + 1 < userArgs.length &&
                !userArgs[i + 1].startsWith('-')
            ) {
                i++;
            }
            continue;
        }
        return token;
    }
    return undefined;
}

/**
 * Parses executable argv (user-space tokens, without node/script).
 * Pure: no side effects; output is only Commander's own usage/version
 * reporting through CliIO.
 */
export async function parseArgv(
    userArgs: string[],
    version: string,
): Promise<ParseOutcome> {
    // Reject unknown commands up front: with a root action handler,
    // Commander would misreport them as "too many arguments".
    const candidate = detectCommandCandidate(userArgs);
    if (candidate && !getCommand(candidate)) {
        throw new CliUsageError(
            `Unknown command [${candidate}].${suggestCommands(candidate)}`,
        );
    }

    const { program, getInvocation } = buildProgram(version);
    try {
        await program.parseAsync(userArgs, { from: 'user' });
    } catch (err) {
        const flow = classifyCommanderError(err);
        if (flow.kind === 'version' || flow.kind === 'help') {
            return { kind: 'terminal' };
        }
        // Commander already printed the error + usage to CliIO.
        throw new CliUsageError(flow.message ?? 'Invalid usage.', true);
    }
    // The root action always captures when no subcommand matched.
    const invocation = getInvocation();
    if (!invocation) {
        throw new CliUsageError('No command parsed.', true);
    }
    return { kind: 'invocation', invocation };
}

/**
 * Legacy embedded-API path: converts the pre-split runCLI(cmd, args, {flags})
 * shape into the same ParsedInvocation the executable path produces, using
 * the command schema to pair flag values. Pure structuring — every semantic
 * check lives in validateInvocation so both paths share one contract.
 *
 * `setProcessArgsOverride` compatibility shim note: the new parser never
 * depends on it; the shim is removed with this rewrite (API v2 will revisit
 * the whole embedded surface).
 */
export function normalizeLegacyInvocation(
    cmdName: string | undefined,
    cmdArgs: string[] | undefined,
    flagTokens: string[] | undefined,
): ParsedInvocation {
    const def = cmdName ? getCommand(cmdName) : undefined;
    const declared: FlagSpec[] = [...GLOBAL_FLAGS, ...(def?.flags ?? [])];
    const byName = new Map(declared.map((f) => [f.name, f]));

    // Tokens may arrive mixed: cmdArgs can contain flag tokens too (the old
    // splitArgs behavior), so structure them together, values consumed per
    // the command schema.
    const tokens = [...(cmdArgs ?? []), ...(flagTokens ?? [])];
    const positionals: string[] = [];
    const options: Record<string, string | boolean | undefined> = {};
    const unknownOptions: string[] = [];
    for (const declaredFlag of declared) {
        options[declaredFlag.name] = undefined;
    }

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token.startsWith('-')) {
            positionals.push(token);
            continue;
        }
        const [rawName, inlineValue] = token.slice(2).split('=', 2);
        const spec = byName.get(rawName);
        if (!spec) {
            unknownOptions.push(`--${rawName}`);
            continue;
        }
        if (!spec.takesValue) {
            options[spec.name] = true;
            continue;
        }
        if (inlineValue !== undefined) {
            options[spec.name] = inlineValue;
            continue;
        }
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
            options[spec.name] = next;
            i++;
        } else {
            options[spec.name] = undefined;
        }
    }

    return {
        commandName: cmdName,
        command: def,
        positionals,
        options,
        unknownOptions,
    };
}

function suggestCommands(name: string): string {
    const lower = name.toLowerCase();
    const candidates = allCommands()
        .map((c) => c.name)
        .filter((n) => {
            const shared = [...n].filter((ch) => lower.includes(ch)).length;
            return shared >= Math.ceil(n.length / 2);
        })
        .slice(0, 3);
    return candidates.length
        ? ` Did you mean one of: ${candidates.join(', ')}?`
        : '';
}

/**
 * Single semantic validation layer shared by the executable and embedded
 * paths: command existence, option names, option values, positional arity.
 * The executable path is pre-validated by Commander, but it still flows
 * through here so both hosts are guaranteed identical semantics.
 */
export function validateInvocation(
    invocation: ParsedInvocation,
): ValidInvocation {
    const { commandName, command, positionals, options, unknownOptions } =
        invocation;

    if (commandName && !command) {
        throw new CliUsageError(
            `Unknown command [${commandName}].${suggestCommands(commandName)}`,
        );
    }
    for (const token of unknownOptions ?? []) {
        throw new CliUsageError(`Unknown option '${token}'.`);
    }

    if (!command) {
        // No command given: banner + help path. Nothing to validate.
        return invocation as ValidInvocation;
    }

    // --help short-circuits every semantic check (pure control flow on both
    // paths); unknown command/option above still take precedence.
    if (options['help'] === true) {
        return invocation as ValidInvocation;
    }

    // Option values: choices for value flags.
    const declared: FlagSpec[] = [...GLOBAL_FLAGS, ...(command.flags ?? [])];
    for (const flag of declared) {
        const value = options[flag.name];
        if (
            flag.takesValue &&
            flag.choices &&
            typeof value === 'string' &&
            !flag.choices.includes(value)
        ) {
            throw new CliUsageError(
                `Invalid --${flag.name} value '${value}' (expected one of: ${flag.choices.join(', ')}).`,
            );
        }
    }

    // Positional arity.
    const specs = command.positionals ?? [];
    const requiredCount = specs.filter((p) => p.required).length;
    const variadic = specs.some((p) => p.variadic);
    if (positionals.length < requiredCount) {
        const missing =
            specs[positionals.length] ?? specs.find((p) => p.required);
        throw new CliUsageError(
            `Missing required argument '<${missing?.name ?? 'arg'}>' for command [${command.name}].`,
        );
    }
    if (!variadic && positionals.length > specs.length) {
        throw new CliUsageError(
            `Too many arguments for command [${command.name}] (expected at most ${specs.length}, got ${positionals.length}).`,
        );
    }

    return invocation as ValidInvocation;
}
