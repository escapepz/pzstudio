export interface FlagSpec {
    name: string;
    short?: string;
    takesValue?: boolean;
    choices?: readonly string[];
    conflicts?: string[];
}

export interface PositionalSpec {
    name: string;
    required?: boolean;
    variadic?: boolean;
}

export interface CommandContext {
    positionals: string[];
    options: Record<string, string | boolean | undefined>;
}

export interface CommandDef {
    name: string;
    summary: string;
    silent?: boolean;
    hidden?: boolean;
    flags?: FlagSpec[];
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

export function allCommands(): CommandDef[] {
    return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

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
    { name: 'yes' },
];
