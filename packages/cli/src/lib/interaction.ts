import fs from 'fs';
import { CliError } from './errors';
import { CliUsageError, getCliIO } from './parser';
import { hasFlag } from './args';

/**
 * How the current invocation may talk to the user (CLI-9). Set once per
 * runCLI invocation, never by business handlers:
 * - 'embedded' — runCLI(cmd, args, {flags}) library calls: NEVER prompt.
 *   Hosts (the VS Code extension) own their confirmation UI and pass
 *   --yes-equivalent intent themselves.
 * - 'interactive' — executable attached to a TTY: destructive actions
 *   prompt for confirmation unless --yes was given.
 * - 'non-interactive' — executable without a TTY (CI, pipes): never
 *   prompt; destructive actions are refused with exit 2 unless --yes
 *   was given.
 */
export type InteractionMode = 'interactive' | 'non-interactive' | 'embedded';

let interactionMode: InteractionMode = 'embedded';

export function setInteractionMode(mode: InteractionMode): void {
    interactionMode = mode;
}

export function getInteractionMode(): InteractionMode {
    return interactionMode;
}

/**
 * Reads one line from stdin without leaving the synchronous command flow.
 * Only reached in interactive mode (a TTY); any failure to read degrades
 * to an empty answer, which the caller treats as a decline — a destructive
 * action never proceeds on an unreadable confirmation.
 */
function readLineSync(): string {
    const buffer = Buffer.alloc(1);
    let line = '';
    while (true) {
        let bytesRead: number;
        try {
            bytesRead = fs.readSync(0, buffer, 0, 1, null);
        } catch {
            return line;
        }
        if (bytesRead === 0) return line;
        const char = buffer.toString('utf8', 0, 1);
        if (char === '\n') return line;
        if (char !== '\r') line += char;
    }
}

type StdinReader = () => string;

let stdinReader: StdinReader = readLineSync;

/**
 * Replaces the stdin line reader (test hook). Pass undefined to restore
 * the real byte-at-a-time TTY reader.
 * @internal
 */
export function setStdinReader(reader: StdinReader | undefined): void {
    stdinReader = reader ?? readLineSync;
}

/**
 * The single consent gate for destructive mutations. Business handlers
 * call this before their first mutation; the policy stays here:
 * - embedded: proceed immediately (no terminal prompting, ever).
 * - --yes passed: proceed.
 * - non-interactive: refuse as a usage error (exit 2) with the exact
 *   command to re-run.
 * - interactive: print the question through CliIO and read one line; any
 *   answer other than y/yes aborts before anything was changed.
 */
export function confirmDestructive(
    command: string,
    args: string[],
    question: string,
): void {
    if (interactionMode === 'embedded') return;
    if (hasFlag('yes')) return;

    if (interactionMode === 'non-interactive') {
        throw new CliUsageError(
            `Refusing '${command}' without confirmation in a non-interactive session. Try: pzstudio ${command}${args.length ? ' ' + args.join(' ') : ''} --yes`,
        );
    }

    const io = getCliIO();
    io.stdout(`${question} [y/N] `);
    const answer = stdinReader().trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
        throw new CliError('Aborted. Nothing was changed.');
    }
}
