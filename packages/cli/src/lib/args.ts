export type ArgType =
    | 'string'
    | 'number'
    | 'boolean'
    | 'string|undefined'
    | 'number|undefined'
    | 'boolean|undefined';

/**
 * Parses the type of the argument
 * @param arg The argument to parse
 * @returns The parsed argument
 */
export function parseArgType(arg: any) {
    if (!arg) return undefined;
    if (!isNaN(arg) && !isNaN(parseFloat(arg))) return parseFloat(arg);
    if (typeof arg === 'string') {
        if (arg.toLowerCase() === 'true') return true;
        if (arg.toLowerCase() === 'false') return false;
    }
    return String(arg);
}

/**
 * Returns the command passed to the program
 * @param argv Optional argument array (defaults to process.argv)
 * @returns {string} The command passed to the program
 */
export function cmd(argv: string[] = process.argv) {
    return argv.slice(2).find((a) => !a.startsWith('-'));
}

/**
 * Returns the arguments passed to the program
 * @param argv Optional argument array (defaults to process.argv)
 * @returns {any[]} The arguments passed to the program
 */
export function args(argv: string[] = process.argv) {
    return argv.slice(3).map((a) => parseArgType(a));
}

/**
 * Returns the argument at the specified index
 * @param {number} index The index of the argument to return
 * @param argv Optional argument array (defaults to process.argv)
 * @returns {any} The argument at the specified index
 */
export function arg(index: number, argv: string[] = process.argv) {
    return args(argv)[index];
}

let processArgsOverride: string[] | undefined;

/**
 * Overrides the args used by processArgs()/hasFlag()/extractFlag().
 * Lets API callers (e.g. the VS Code extension) pass flags explicitly
 * instead of mutating process.argv.
 * @param args Already-sliced args (without node/script), or undefined to restore argv parsing
 */
export function setProcessArgsOverride(args: string[] | undefined) {
    processArgsOverride = args;
}

export function processArgs(argv: string[] = process.argv) {
    return processArgsOverride ?? argv.slice(2);
}

/**
 * Extract a flag value from the raw argument tokens
 * @param name The flag name (without dashes)
 * @returns The flag value or undefined
 */
export function extractFlag(name: string): string | undefined {
    const allArgs = processArgs();
    const flagIndex = allArgs.findIndex((a) => a === `--${name}`);
    if (flagIndex !== -1 && flagIndex + 1 < allArgs.length) {
        const val = allArgs[flagIndex + 1];
        if (val.startsWith('--')) {
            return undefined;
        }
        return val;
    }
    return undefined;
}

/**
 * Check if a flag exists in the raw argument tokens
 * @param name The flag name (without dashes)
 * @returns True if the flag exists
 */
export function hasFlag(name: string): boolean {
    return processArgs().some((a) => a === `--${name}`);
}

/**
 * Separates flags from positional arguments.
 * @param rawArgs The raw arguments to process
 * @returns An object containing the separated flags and positionals
 */
export function splitArgs(rawArgs: string[]) {
    const positionals: string[] = [];
    const flags: string[] = [];

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (arg.startsWith('-')) {
            flags.push(arg);
        } else {
            positionals.push(arg);
        }
    }

    return { flags, positionals };
}
