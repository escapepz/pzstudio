import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { expect } from '../expect';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { CliError } from '../errors';
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

/**
 * Handle the modinfo command.
 * @param action The action to perform (e.g., 'generate').
 * @param modId The ID of the mod to process (optional).
 */
export async function modinfoCmd(action: string, modId?: string) {
    expect('param [action]', action, 'string');
    expect('param [modId]', modId, 'string|undefined');

    const projectConfig = resolveProjectConfig();
    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }

    // The mod-folder walk must use THIS invocation's project root — the
    // same ctx-aware discovery resolveProjectConfig just used. The helper's
    // implicit default (legacyProjectDir) reads the raw legacy anchor
    // slots, which embedded hosts never write (doc 11 §8.0 R0/R1: the v2
    // runtime stores nothing in the facade slots) — it would fall back to
    // the host process's cwd and fail with "No pzstudio project found."
    // even though the project was passed in explicitly (sweep d08-B5: the
    // VS Code extension anchors every run through the invocation context).
    // Inject the root through the whole command instead.
    const projectRoot = projectDir();

    if (action === 'generate') {
        if (modId) {
            await generateForMod(modId, projectConfig, projectRoot);
        } else {
            await generateForAll(projectConfig, projectRoot);
        }
    } else {
        throw new Error(`Unknown modinfo action [${action}]`);
    }
}

/**
 * Generate mod.info for a specific mod.
 * @param modId The mod id
 * @param projectConfig The project config
 * @param projectRoot The invocation-resolved project root the mod folder
 *   lives under (same discovery resolveProjectConfig used — never the
 *   legacy ambient default).
 */
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
    // --force overwrites existing files regardless of the auto-if-missing
    // default; build.modInfo "auto" already means overwrite.
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

/**
 * Generate mod.info for all eligible mods.
 * @param projectConfig The project config
 * @param projectRoot The invocation-resolved project root
 */
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
