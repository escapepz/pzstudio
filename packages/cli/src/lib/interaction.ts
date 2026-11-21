import fs from 'fs';
import { CliError } from './errors';
import { CliUsageError, getCliIO } from './parser';
import { hasFlag } from './args';
import { getActiveInvocationContext, type InteractionMode } from './invocation';

export type { InteractionMode };

let interactionMode: InteractionMode = 'embedded';

export function setInteractionMode(mode: InteractionMode): void {
    interactionMode = mode;
}

export function getInteractionMode(): InteractionMode {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        return ctx.interactionMode;
    }
    return interactionMode;
}

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

export function setStdinReader(reader: StdinReader | undefined): void {
    stdinReader = reader ?? readLineSync;
}

export function confirmDestructive(
    command: string,
    args: string[],
    question: string,
): void {
    if (hasFlag('yes')) return;

    const mode = getInteractionMode();
    if (mode === 'embedded') {
        throw new CliUsageError(
            `Refusing '${command}' without explicit confirmation (embedded API). Pass { flags: ['--yes'] } once your host UI has confirmed, or use --dry-run to preview.`,
        );
    }

    if (mode === 'non-interactive') {
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
