import { addHelp } from '../help';
import { registerCommand } from '../registry';

addHelp(
    'watch',
    `Watch your project and update your output directory with your project.

    Usages:
        pzstudio watch - Watch your project and update your output directory with your project.
    
    WARNING: This command is EXPERIMENTAL and may not handle all edge cases correctly. Use with caution.`,
);

export async function watchCmd() {
    throw new Error('Not implemented yet!');
}

registerCommand({
    name: 'watch',
    summary: 'Watch for changes and keep your output directory synced.',
    run: () => watchCmd(),
});
