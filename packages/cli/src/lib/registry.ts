/**
 * Command registry: each command file registers itself at import time.
 * The CLI dispatcher looks commands up here instead of a hand-maintained
 * switch, so adding a command only means creating its file.
 */
export interface CommandContext {
    /**
     * Positional arguments after the command name, kept as raw strings
     * (mod ids must not be coerced to numbers).
     */
    positionals: string[];
}

export interface CommandDef {
    name: string;
    /** One-line description shown by `pzstudio help`. */
    summary: string;
    /** Skip the "Command [x] completed." announcement (long/noisy commands). */
    silent?: boolean;
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
