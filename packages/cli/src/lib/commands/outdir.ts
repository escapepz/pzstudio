import { resolve } from 'path';
import { existsSync, statSync } from 'fs';
import { expect } from '../expect';
import { CliError } from '../errors';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { engineIo, log, verbose } from '../logger';
import { readGlobalConfig, writeGlobalConfig } from '../templateManager';

addHelp(
    'outdir',
    `Set the machine-level deployment root for your mods.

    Builds always write the canonical dist/ output inside the project; the
    deployment root is where the game reads them from — each built item is
    exposed there as a junction ('symlink' mode, the default) or a verified
    copy ('copy' mode). A project.json outdir wins over this machine-level
    value; with neither set, builds write dist/ only (no deployment).

    Usages:
        pzstudio outdir <newOutDir> - Change the machine-level deployment root.

    Flags:
        --verbose        - Enable diagnostic output.`,
);

export function outdirCmd(newOutDir: string) {
    expect('param [newOutDir]', newOutDir, 'string');

    verbose(`Changing outdir to: ${newOutDir}`);

    // resolve the path
    newOutDir = resolve(newOutDir);
    verbose(`Resolved outdir path: ${newOutDir}`);

    // check if the new path exists and is a directory
    if (!existsSync(newOutDir)) {
        verbose(`Validation failed: Path ${newOutDir} does not exist.`);
        throw new CliError(
            `The deployment directory "${newOutDir}" does not exist.`,
            {
                tryHint:
                    'Create the directory first, then run pzstudio outdir again.',
            },
        );
    }
    if (!statSync(newOutDir).isDirectory()) {
        verbose(`Validation failed: Path ${newOutDir} is not a directory.`);
        throw new CliError(`"${newOutDir}" is not a directory.`, {
            tryHint: 'Pass the path to a directory, not to a file.',
        });
    }

    const config = readGlobalConfig(true, engineIo());
    verbose(`Current outdir: ${config.outdir}`);

    // check if the new path is the same as the old one
    if (config.outdir && config.outdir === newOutDir) {
        verbose(`Validation failed: New path is the same as current path.`);
        throw new Error('The output directory is already set to this value.');
    }

    // write the new path to config.json
    verbose(`Writing new outdir to global config...`);
    config.outdir = newOutDir;
    writeGlobalConfig(config);
    log(`The deployment root has been changed to "${newOutDir}".`);
}

registerCommand({
    name: 'outdir',
    summary: 'Set the machine-level deployment root for your mods.',
    positionals: [{ name: 'path', required: true }],
    run: (ctx) => outdirCmd(ctx.positionals[0]),
});
