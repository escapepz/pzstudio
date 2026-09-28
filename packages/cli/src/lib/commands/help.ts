import { expect } from '../expect';
import { addHelp, getHelp } from '../help';
import { registerCommand, allCommands } from '../registry';
import { log } from '../logger';

function buildFullHelp(): string {
    const lines = allCommands().map(
        (c) => `    ${c.name.padEnd(15)}- ${c.summary}`,
    );
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
            throw new Error(`Unknown command [${command}]`);
        }
    }
}

registerCommand({
    name: 'help',
    summary: 'Displays help information.',
    silent: true,
    run: (ctx) => helpCmd(ctx.positionals[0]),
});
