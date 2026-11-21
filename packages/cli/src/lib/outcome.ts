import { CliError } from './errors';

export type OperationSeverity = 'success' | 'warning' | 'failure';

export interface OperationOutcome {
    severity: OperationSeverity;
}

export const OUTCOME_SUCCESS: OperationOutcome = { severity: 'success' };
export const OUTCOME_WARNING: OperationOutcome = { severity: 'warning' };
export const OUTCOME_FAILURE: OperationOutcome = { severity: 'failure' };

export function aggregateOutcomeSeverity(
    outcomes: OperationOutcome[],
): OperationSeverity {
    if (outcomes.some((o) => o.severity === 'failure')) return 'failure';
    if (outcomes.some((o) => o.severity === 'warning')) return 'warning';
    return 'success';
}

export function throwOnOutcomeFailures(
    outcomes: OperationOutcome[],
    summary: string,
): void {
    if (aggregateOutcomeSeverity(outcomes) === 'failure') {
        throw new CliError(summary);
    }
}
