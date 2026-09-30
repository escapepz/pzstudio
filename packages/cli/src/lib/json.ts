import { log } from './logger';

/**
 * Machine JSON contract v1 (CLI-8). Commands opting in (`list --json`,
 * `doctor --json`) print exactly one envelope on stdout and no human
 * report:
 *
 *     { "schemaVersion": 1, "command": "doctor", "result": { ... } }
 *
 * Failure semantics of a --json invocation:
 *   1. Command executed and produced a domain result:
 *      stdout = envelope, stderr = diagnostics only, exit 0/1 FOLLOWING
 *      THE RESULT (e.g. doctor with blocking issues prints the envelope
 *      whose result.status is 'error' and still exits 1).
 *   2. Runtime failure before a result exists: stdout stays EMPTY,
 *      stderr carries the error, exit 1.
 *   3. Parser/usage failure: stdout stays EMPTY, stderr carries the usage
 *      error, exit 2.
 * In other words stdout may be empty on invocation/runtime failure —
 * machine consumers must not assume the envelope exists on non-zero
 * exits.
 *
 * Compatibility rule: a schemaVersion 1 patch may only ADD optional
 * fields — never rename, remove, or reinterpret existing ones. Minor
 * bumps follow patch unless documented; only a major change moves
 * schemaVersion to 2.
 */
export const JSON_SCHEMA_VERSION = 1;

/**
 * Prints the v1 envelope to stdout (the data stream). The result shape is
 * owned by the command; only semantic fields belong in it, no human prose.
 */
export function printJsonEnvelope(command: string, result: unknown): void {
    const envelope = {
        schemaVersion: JSON_SCHEMA_VERSION,
        command,
        result,
    };
    log(JSON.stringify(envelope, null, 2));
}
