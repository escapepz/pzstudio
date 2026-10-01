import { expect } from '../expect';
import { addHelp, getHelp } from '../help';
import { registerCommand, allCommands } from '../registry';
import { log } from '../logger';
import { CliUsageError, suggestCommands } from '../parser';

function buildFullHelp(): string {
    // Hidden commands (CLI-7) stay registered and runnable but are not
    // advertised in the generated listing.
    const lines = allCommands()
        .filter((c) => !c.hidden)
        .map((c) => `    ${c.name.padEnd(15)}- ${c.summary}`);
    return `Available commands:\n${lines.join('\n')}`;
}

addHelp(
    'help',
    `Displays help information.

    Usages:
        pzstudio help           - Displays general help information.
        pzstudio help <command> - Displays help information for a specific command.`,
);

export function helpCmd(command?: string) {
    expect('param [command]', command, 'string|undefined');

    if (!command) {
        log(buildFullHelp());
    } else {
        const helpText = getHelp(command);
        if (helpText) {
            log(helpText);
        } else {
            // Asking help for a command that does not exist is a usage
            // error (exit 2), not a runtime failure — same classification
            // and suggestion as the parser's unknown-command path.
            throw new CliUsageError(
                `Unknown command [${command}].${suggestCommands(command)}`,
            );
        }
    }
}

registerCommand({
    name: 'help',
    summary: 'Displays help information.',
    silent: true,
    positionals: [{ name: 'command', required: false }],
    run: (ctx) => helpCmd(ctx.positionals[0]),
});
