import { describe, it, expect } from 'vitest';
import {
    OUTCOME_FAILURE,
    OUTCOME_SUCCESS,
    OUTCOME_WARNING,
    aggregateOutcomeSeverity,
    throwOnOutcomeFailures,
} from '../../packages/cli/src/lib/outcome';
import { CliError } from '../../packages/cli/src/lib/errors';

describe('OperationOutcome aggregation (CLI-6)', () => {
    it('any failure wins over warnings and successes', () => {
        expect(
            aggregateOutcomeSeverity([
                OUTCOME_SUCCESS,
                OUTCOME_FAILURE,
                OUTCOME_WARNING,
            ]),
        ).toBe('failure');
        expect(aggregateOutcomeSeverity([OUTCOME_FAILURE])).toBe('failure');
    });

    it('warnings keep the operation green when there is no failure', () => {
        expect(
            aggregateOutcomeSeverity([OUTCOME_SUCCESS, OUTCOME_WARNING]),
        ).toBe('warning');
        expect(aggregateOutcomeSeverity([OUTCOME_SUCCESS])).toBe('success');
        expect(aggregateOutcomeSeverity([])).toBe('success');
    });

    it('throwOnOutcomeFailures throws a CliError only on failure', () => {
        expect(() =>
            throwOnOutcomeFailures([OUTCOME_FAILURE], 'summary'),
        ).toThrow(CliError);
        expect(() =>
            throwOnOutcomeFailures([OUTCOME_FAILURE], 'summary'),
        ).toThrow('summary');
        expect(() =>
            throwOnOutcomeFailures(
                [OUTCOME_SUCCESS, OUTCOME_WARNING],
                'summary',
            ),
        ).not.toThrow();
    });
});
