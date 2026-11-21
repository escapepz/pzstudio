import { Command, CommanderError, Option } from 'commander';

export { CommanderError };
import {
    allCommands,
    getCommand,
    CommandDef,
    FlagSpec,
    GLOBAL_FLAGS,
    PositionalSpec,
} from './registry';

export interface CliIO {
    stdout(text: string): void;
    stderr(text: string): void;
}

const processIO: CliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
};

let activeIO: CliIO = processIO;

export function setCliIO(sink: CliIO | undefined): void {
    activeIO = sink ?? processIO;
}

export function getCliIO(): CliIO {
    return activeIO;
}

export interface ParsedInvocation {
    commandName?: string;
    command?: CommandDef;
    positionals: string[];
    options: Record<string, string | boolean | undefined>;
    unknownOptions?: string[];
    presence?: ReadonlySet<string>;
}

export type ValidInvocation = ParsedInvocation & {
    command: CommandDef;
};

export class CliUsageError extends Error {
    readonly alreadyReported: boolean;

    constructor(message: string, alreadyReported = false) {
        super(message);
        this.name = 'CliUsageError';
        this.alreadyReported = alreadyReported;
    }
}

type ControlFlowKind = 'help' | 'version' | 'usage';

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

function addFlag(cmd: Command, flag: FlagSpec, seenFlags: Set<string>): void {
    const value = flag.takesValue ? ' <value>' : '';
    const long = `--${flag.name}${value}`;
    const token = flag.short ? `-${flag.short}, ${long}` : long;
    const opt = new Option(token, flag.name);
    if (flag.choices) {
        opt.choices([...flag.choices]);
    }
    cmd.addOption(opt);
    cmd.on(`option:${flag.name}`, () => seenFlags.add(flag.name));
}

function addPositional(cmd: Command, spec: PositionalSpec): void {
    const token = spec.variadic ? `[${spec.name}...]` : `[${spec.name}]`;
    cmd.argument(token);
}

function buildProgram(version: string): {
    program: Command;
    getInvocation: () => ParsedInvocation | undefined;
} {
    const program = new Command();
    let captured: ParsedInvocation | undefined;
    const seenFlags = new Set<string>();

    program
        .name('pzstudio')
        .version(`v${version}`)
        .exitOverride()
        .showSuggestionAfterError(true)
        .helpOption(false)
        .addHelpCommand(false)
        .configureOutput({
            writeOut: (text) => activeIO.stdout(text),
            writeErr: (text) => activeIO.stderr(text),
        });

    for (const flag of GLOBAL_FLAGS) {
        addFlag(program, flag, seenFlags);
    }

    program.action((...cbArgs: unknown[]) => {
        const cmd = cbArgs[cbArgs.length - 1] as Command;
        captured = toInvocation(
            undefined,
            cmd.optsWithGlobals() as Record<string, unknown>,
            [],
            seenFlags,
        );
    });

    for (const def of allCommands()) {
        const sub = program.command(def.name);
        sub.description(def.summary).helpOption(false);
        for (const flag of GLOBAL_FLAGS) {
            addFlag(sub, flag, seenFlags);
        }
        for (const flag of def.flags ?? []) {
            addFlag(sub, flag, seenFlags);
        }
        for (const spec of def.positionals ?? []) {
            addPositional(sub, spec);
        }
        sub.action((...cbArgs: unknown[]) => {
            const cmd = cbArgs[cbArgs.length - 1] as Command;
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
            captured = toInvocation(def, options, positionals, seenFlags);
        });
    }

    return { program, getInvocation: () => captured };
}

function toInvocation(
    def: CommandDef | undefined,
    commanderOptions: Record<string, unknown>,
    positionals: string[],
    seenFlags: Set<string>,
): ParsedInvocation {
    const declared: FlagSpec[] = [...GLOBAL_FLAGS, ...(def?.flags ?? [])];
    const options: Record<string, string | boolean | undefined> = {};
    for (const flag of declared) {
        // Commander models `--no-x` as the negation of the positive
        // attribute (`x: false`) and never stores a `noX` key. Presence
        // (not the value) is the truth: `--path --no-materialize` consumes
        // the token as a value yet still leaves Commander's implicit
        // `materialize: true` behind, which a value-based read would
        // misreport as "the flag was used".
        if (flag.name.startsWith('no-')) {
            options[flag.name] = seenFlags.has(flag.name) ? true : undefined;
            continue;
        }
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
        presence: new Set(seenFlags),
    };
}

export type ParseOutcome =
    | { kind: 'invocation'; invocation: ParsedInvocation }
    | { kind: 'terminal' };

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
        throw new CliUsageError(flow.message ?? 'Invalid usage.', true);
    }
    const invocation = getInvocation();
    if (!invocation) {
        throw new CliUsageError('No command parsed.', true);
    }
    return { kind: 'invocation', invocation };
}

export function normalizeLegacyInvocation(
    cmdName: string | undefined,
    cmdArgs: string[] | undefined,
    flagTokens: string[] | undefined,
): ParsedInvocation {
    const def = cmdName ? getCommand(cmdName) : undefined;
    const declared: FlagSpec[] = [...GLOBAL_FLAGS, ...(def?.flags ?? [])];
    const byName = new Map(declared.map((f) => [f.name, f]));

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
        .filter((c) => !c.hidden)
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
export { suggestCommands };

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
        return invocation as ValidInvocation;
    }

    if (options['help'] === true) {
        return invocation as ValidInvocation;
    }

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

    const presence = invocation.presence;
    const isPresent = (name: string): boolean =>
        presence
            ? presence.has(name)
            : options[name] !== undefined && options[name] !== false;
    for (const flag of declared) {
        if (!flag.conflicts || !isPresent(flag.name)) continue;
        const clash = flag.conflicts.find(isPresent);
        if (clash) {
            throw new CliUsageError(
                `Conflicting options: --${flag.name} cannot be combined with --${clash}.`,
            );
        }
    }

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
