import { expect } from '../expect';
import { addHelp, getHelp } from '../help';
import { log } from '../logger';

const fullHelp = `Available commands:
    add            - Add a mod to your project.
    build          - Build your project and package it for the workshop.
    clean          - Clean your output directory from the current built project.
    delete         - Delete a mod from your project.
    help           - Displays help information.
    lang           - Add or copy a translation language.
    migrate        - Upgrade legacy config.json and project.json files.
    modinfo        - Generate mod.info files for your mods.
    new            - Create a new project.
    outdir         - Set your output directory.
    rename         - Rename a mod from your project.
    update         - Refresh the cached template repositories.
    watch          - Watch for changes and keep your output directory synced.`;

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
        log(fullHelp);
    } else {
        const helpText = getHelp(command);
        if (helpText) {
            log(helpText);
        } else {
            throw new Error(`Unknown command [${command}]`);
        }
    }
}
