import { CliUsageError } from './parser';

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
    debug?: boolean;
}

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
