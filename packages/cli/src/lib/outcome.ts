import { CliError } from './errors';

/**
 * Structured result of one part of a multi-part operation (CLI-6). Severity
 * is an enum, not prose: commands record one outcome per part and the exit
 * decision is mechanical — any `failure` part fails the whole command, so
 * `build --both` can still finish the development output after the main
 * output failed while the bin still exits 1. `warning` parts are advisory
 * and never flip the exit code.
 */
export type OperationSeverity = 'success' | 'warning' | 'failure';

export interface OperationOutcome {
    severity: OperationSeverity;
}

export const OUTCOME_SUCCESS: OperationOutcome = { severity: 'success' };
export const OUTCOME_WARNING: OperationOutcome = { severity: 'warning' };
export const OUTCOME_FAILURE: OperationOutcome = { severity: 'failure' };

/**
 * Reduces recorded outcomes to the operation's overall severity:
 * any failure wins, else any warning, else success.
 */
export function aggregateOutcomeSeverity(
    outcomes: OperationOutcome[],
): OperationSeverity {
    if (outcomes.some((o) => o.severity === 'failure')) return 'failure';
    if (outcomes.some((o) => o.severity === 'warning')) return 'warning';
    return 'success';
}

/**
 * Exit-rule enforcement for commands that run parts independently: throws
 * a structured error (exit 1 via the bin) when any outcome failed, while
 * warnings keep the command green (exit 0). The summary is the caller's
 * problem/summary text.
 */
export function throwOnOutcomeFailures(
    outcomes: OperationOutcome[],
    summary: string,
): void {
    if (aggregateOutcomeSeverity(outcomes) === 'failure') {
        throw new CliError(summary);
    }
}
