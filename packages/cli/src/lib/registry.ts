/**
 * Command registry: each command file registers itself at import time.
 * The CLI dispatcher looks commands up here instead of a hand-maintained
 * switch, so adding a command only means creating its file.
 *
 * Since the Commander parser (lib/parser.ts) is built from this registry,
 * the declared `flags`/`positionals` metadata below is the single source of
 * truth for what each command accepts — both for the executable path
 * (parseArgv) and the embedded API path (normalizeLegacyInvocation).
 */
export interface FlagSpec {
    /** Long option name without dashes (e.g. 'force-update' for --force-update). */
    name: string;
    /** Short option character without dash (e.g. 'C' for -C). */
    short?: string;
    /** Accepts a value (`--path <value>`); when omitted the flag is boolean. */
    takesValue?: boolean;
    /** Allowed values (value flags only); others are rejected as usage errors. */
    choices?: readonly string[];
    /**
     * Names of flags this one must not be combined with. Enforced by
     * validateInvocation() so both hosts share the same usage-error
     * semantics (e.g. build/watch --production vs --development vs --both).
     */
    conflicts?: string[];
}

export interface PositionalSpec {
    /** Argument name shown in usage text. */
    name: string;
    /** Must be present (defaults to required for the first declared positionals? no: explicit). */
    required?: boolean;
    /** Collects all remaining arguments (must be last). */
    variadic?: boolean;
}

export interface CommandContext {
    /**
     * Positional arguments after the command name, kept as raw strings
     * (mod ids must not be coerced to numbers).
     */
    positionals: string[];
    /**
     * Parsed options for this invocation (global + command flags), keyed by
     * dash-case name. Boolean flags are `true`; value flags carry the string.
     */
    options: Record<string, string | boolean | undefined>;
}

export interface CommandDef {
    name: string;
    /** One-line description shown by `pzstudio help`. */
    summary: string;
    /** Skip the "Command [x] completed." announcement (long/noisy commands). */
    silent?: boolean;
    /**
     * Keeps the command registered and runnable (old routes keep working)
     * while omitting it from the generated help listing (CLI-7).
     */
    hidden?: boolean;
    /** Flags this command accepts (global flags --verbose/--transport/--help are always available). */
    flags?: FlagSpec[];
    /** Positional arguments this command accepts. */
    positionals?: PositionalSpec[];
    run: (ctx: CommandContext) => void | Promise<void>;
}

const registry = new Map<string, CommandDef>();

export function registerCommand(def: CommandDef): void {
    registry.set(def.name, def);
}

export function getCommand(name: string): CommandDef | undefined {
    return registry.get(name);
}

/** All registered commands, sorted alphabetically by name. */
export function allCommands(): CommandDef[] {
    return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Flags accepted by every command (parsed on the root program and repeated on subcommands). */
export const GLOBAL_FLAGS: FlagSpec[] = [
    { name: 'verbose' },
    { name: 'quiet' },
    { name: 'debug' },
    {
        name: 'transport',
        takesValue: true,
        choices: ['git', 'fetch'],
    },
    {
        name: 'project',
        short: 'C',
        takesValue: true,
    },
    { name: 'help' },
];
