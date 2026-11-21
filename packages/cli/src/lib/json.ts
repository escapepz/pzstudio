import { log } from './logger';

export const JSON_SCHEMA_VERSION = 1;

export function printJsonEnvelope(command: string, result: unknown): void {
    const envelope = {
        schemaVersion: JSON_SCHEMA_VERSION,
        command,
        result,
    };
    log(JSON.stringify(envelope, null, 2));
}
