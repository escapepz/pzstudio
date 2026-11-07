import { CliUsageError } from './parser';

/**
 * Structured, user-facing CLI error (CLI-3 error model). The message stays
 * the bare problem statement — unit tests and embedders match on it — while
 * the optional `cause` and `tryHint` fields are rendered by formatError as
 * the Cause/Try lines. Throw sites convert to this class incrementally; any
 * error that is not a CliError still prints through the unexpected-error
 * wrapper, so nothing regresses while commands keep throwing plain Errors.
 */
export class CliError extends Error {
    readonly problem: string;
    readonly cause?: string;
    readonly tryHint?: string;

    constructor(
        problem: string,
        fields: { cause?: string; tryHint?: string } = {},
    ) {
        super(problem);
        this.name = 'CliError';
        this.problem = problem;
        this.cause = fields.cause;
        this.tryHint = fields.tryHint;
    }
}

export interface FormatErrorOptions {
    /** When true, unexpected errors include the full stack trace. */
    debug?: boolean;
}

/**
 * Renders any thrown value for the [ERROR] stderr line (CLI-3 contract):
 * - CliUsageError: the message only — usage failures are input problems.
 * - CliError: Problem/Cause/Try block, or the bare problem text when no
 *   extra fields are present.
 * - Anything else: wrapped as "Unexpected error" — the full stack appears
 *   only under --debug, otherwise a hint line points at it.
 * The returned text carries no [ERROR] prefix and no color: the logger
 * owns both.
 */
export function formatError(
    e: unknown,
    options: FormatErrorOptions = {},
): string {
    if (e instanceof CliUsageError) {
        return e.message;
    }
    if (e instanceof CliError) {
        if (!e.cause && !e.tryHint) {
            return e.problem;
        }
        const lines = [`Problem: ${e.problem}`];
        if (e.cause) {
            lines.push(`Cause: ${e.cause}`);
        }
        if (e.tryHint) {
            lines.push(`Try: ${e.tryHint}`);
        }
        return lines.join('\n        ');
    }
    const message = e instanceof Error ? e.message : String(e);
    const wrapped = `Unexpected error: ${message}`;
    if (options.debug) {
        return e instanceof Error && e.stack
            ? `${wrapped}\n${e.stack}`
            : wrapped;
    }
    return `${wrapped}\nRun with --debug for the full stack trace.`;
}
