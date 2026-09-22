import { addHelp } from '../help';

addHelp(
    'lang',
    `Add or copy a translation language.

    Usages:
        pzstudio lang <modId> <lang>          - Add a translation language.
        pzstudio lang <modId> <lang> <toLang> - Copy a translation language to an other language.`,
);

export function langCmd(modId: string, lang: string, toLang?: string) {
    throw new Error('Not implemented yet!');
}
