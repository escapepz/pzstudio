import { addHelp } from '../help';
import { registerCommand } from '../registry';

addHelp(
    'lang',
    `Add or copy a translation language.

    Usages:
        pzstudio lang <modId> <lang>          - Add a translation language.
        pzstudio lang <modId> <lang> <toLang> - Copy a translation language to an other language.`,
);

export function langCmd(_modId: string, _lang: string, _toLang?: string) {
    throw new Error('Not implemented yet!');
}

registerCommand({
    name: 'lang',
    summary: 'Add or copy a translation language.',
    positionals: [
        { name: 'modId', required: true },
        { name: 'lang', required: true },
        { name: 'toLang', required: false },
    ],
    run: (ctx) =>
        langCmd(ctx.positionals[0], ctx.positionals[1], ctx.positionals[2]),
});
