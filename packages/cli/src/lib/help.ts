const helps: { [command: string]: string } = {};

export function addHelp(command: string, help: string) {
    helps[command] = help;
}

export function getHelp(command: string) {
    return helps[command];
}

export function getAvailableCommands(): string[] {
    return Object.keys(helps);
}
