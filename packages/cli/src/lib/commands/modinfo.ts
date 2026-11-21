import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect } from '../expect';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { CliError } from '../errors';
import { CliUsageError } from '../parser';
import { hasFlag } from '../args';
import { log, verbose } from '../logger';
import {
    generateModInfoText,
    projectDir,
    resolveProjectConfig,
    resolveModInfoTargets,
} from '../helper';

addHelp(
    'modinfo',
    `Generate mod.info files for your mods in the source tree.

    Usages:
        pzstudio modinfo generate          - Generate mod.info for all mods.
        pzstudio modinfo generate <modId> - Generate mod.info for a specific mod.
    
    Flags:
        --force          - Overwrite existing mod.info files (default: skip files that already exist).
        --verbose        - Enable diagnostic output.`,
);

export async function modinfoCmd(action: string, modId?: string) {
    expect('param [action]', action, 'string');
    expect('param [modId]', modId, 'string|undefined');

    const projectConfig = resolveProjectConfig();
    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }

    const projectRoot = projectDir();

    if (action === 'generate') {
        if (modId) {
            await generateForMod(modId, projectConfig, projectRoot);
        } else {
            await generateForAll(projectConfig, projectRoot);
        }
    } else {
        throw new CliUsageError(
            `Unknown modinfo action '${action}' (expected one of: generate).`,
        );
    }
}

async function generateForMod(
    modId: string,
    projectConfig: any,
    projectRoot: string,
) {
    const mod = projectConfig.mods[modId];
    if (!mod) {
        throw new Error(`Mod [${modId}] not found in project.json`);
    }

    const modInfoFlag = mod.build?.modInfo ?? 'auto-if-missing';
    if (modInfoFlag === 'skip') {
        verbose(`Mod '${modId}' is configured to skip mod.info generation.`);
        log(
            `- Skipping '${modId}' mod.info generation (build.modInfo: "skip")...`,
        );
        return;
    }

    verbose(`Resolving mod.info targets for mod '${modId}'...`);
    const targets = resolveModInfoTargets(modId, projectRoot);
    if (targets.length === 0) {
        verbose(`No Build 42 targets found for mod '${modId}'.`);
        log(
            `- No valid Build 42 branch folders found for mod '${modId}'. Skipping...`,
        );
        return;
    }

    verbose(`Found targets for '${modId}': ${targets.join(', ')}`);
    const overwrite = hasFlag('force') || modInfoFlag === 'auto';
    for (const targetDir of targets) {
        const modInfoPath = join(targetDir, 'mod.info');
        if (!overwrite && existsSync(modInfoPath)) {
            verbose(
                `Mod '${modId}' already has mod.info in '${targetDir}'. Skipping...`,
            );
            log(
                `- Skipping '${modId}' mod.info in '${targetDir}' (already exists, use --force to overwrite)...`,
            );
            continue;
        }

        verbose(`Generating mod.info content for '${modId}'...`);
        log(`- Generating mod.info for '${modId}' in '${targetDir}'...`);
        const content = generateModInfoText(modId, projectConfig);
        verbose(`Writing mod.info to: ${modInfoPath}`);
        writeFileSync(modInfoPath, content);
    }
}

async function generateForAll(projectConfig: any, projectRoot: string) {
    log('Generating mod.info for all eligible mods...');
    const mods = Object.keys(projectConfig.mods).filter((id) => {
        const isExcluded = projectConfig.excludes.includes(id);
        if (isExcluded) {
            verbose(`Mod '${id}' is explicitly excluded from generation.`);
        }
        return !isExcluded;
    });

    verbose(`Eligible mods for mod.info: ${mods.join(', ')}`);

    for (const modId of mods) {
        await generateForMod(modId, projectConfig, projectRoot);
    }
}

registerCommand({
    name: 'modinfo',
    summary: 'Generate mod.info files for your mods.',
    silent: true,
    flags: [{ name: 'force' }],
    positionals: [
        { name: 'action', required: true },
        { name: 'modId', required: false },
    ],
    run: (ctx) => modinfoCmd(ctx.positionals[0], ctx.positionals[1]),
});
