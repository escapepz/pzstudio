/**
 * Flag readers for command handlers.
 *
 * Since the Commander parser rewrite (CLI-1), flags no longer come from
 * process.argv: the dispatcher parses the invocation (schema-declared in the
 * registry) and publishes the resulting option map here for the duration of
 * exactly one invocation. hasFlag/extractFlag are thin readers over that map
 * so command handlers keep their imperative style without owning parsing.
 */
type InvocationOptions = Record<string, string | boolean | undefined>;

let currentInvocationOptions: InvocationOptions = {};

/**
 * Publishes the parsed options for the invocation being executed.
 * Called by the dispatcher (lib/cli.ts); pass undefined to clear.
 * @internal
 */
export function setInvocationOptions(
    options: InvocationOptions | undefined,
): void {
    currentInvocationOptions = options ?? {};
}

/**
 * Extract a flag value from the current invocation's parsed options.
 * @param name The flag name (without dashes)
 * @returns The flag value or undefined
 */
export function extractFlag(name: string): string | undefined {
    const value = currentInvocationOptions[name];
    return typeof value === 'string' ? value : undefined;
}

/**
 * Check if a flag is set in the current invocation's parsed options.
 * @param name The flag name (without dashes)
 * @returns True if the flag is present (boolean or valued)
 */
export function hasFlag(name: string): boolean {
    const value = currentInvocationOptions[name];
    return value === true || typeof value === 'string';
}
