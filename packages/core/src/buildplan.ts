/**
 * Pure build planner for PZ workshop output.
 *
 * This module is deliberately free of any I/O (fs/path/child_process): it takes
 * a fully-resolved project config plus a snapshot of the source tree state and
 * returns the ordered list of operations an adapter must execute to produce a
 * workshop build. The Node adapter lives in src/lib/commands/build.ts; a
 * browser adapter (web export as .zip) can consume the same plan.
 */
import type { IProjectConfig } from './project';
import { modInfoText, patchModInfoId, workshopText } from './textgen';

export type FileOperation =
    | { type: 'log'; level: 'verbose' | 'info' | 'warn'; message: string }
    | { type: 'removeDir'; path: string }
    | { type: 'makeDir'; path: string }
    | {
          type: 'copyTree';
          from: string;
          to: string;
          excludeIgnoreFile?: boolean;
          ignoreDotFiles?: boolean;
          ignoreItems?: string[];
      }
    | { type: 'writeFile'; path: string; content: string }
    | { type: 'copyFile'; from: string; to: string };

export interface ModSourceState {
    /** Names of the mod's direct subdirectories that contain a media/ folder. */
    branchFolders: string[];
    /**
     * mod.info presence per candidate target: '' is the mod root, otherwise a
     * branch folder name.
     */
    modInfoExists: Record<string, boolean>;
    /**
     * mod.info content per candidate target (same keys as modInfoExists),
     * only meaningful where modInfoExists is true. The development variant
     * uses it to rewrite the id of a copied mod.info; when no content is
     * snapshotted the planner falls back to copying the file verbatim.
     */
    modInfoContent?: Record<string, string | undefined>;
}

export interface PlanBuildInput {
    /** Fully-resolved project config: defaults applied and outdir absolute. */
    config: IProjectConfig;
    variant: 'main' | 'development';
    /** Absolute path to the resolved workshop template directory. */
    workshopTemplateDir: string;
    /** Absolute path to the project root (contains mod folders and workshop/). */
    projectDir: string;
    /** Source-tree snapshot per mod id (unprefixed). */
    modSourceStates: Record<string, ModSourceState>;
    /** Lines from workshop/description.txt, already newline-split. */
    descriptionLines?: string[];
    /** Whether workshop/preview.png exists in the project. */
    previewPngExists: boolean;
}

interface VariantOptions {
    /** Suffix appended to every mod id and its output folder. */
    modIdSuffix: string;
    overrideVisibility?: string;
    excludeId: boolean;
    titleSuffix?: string;
}

const VARIANT_OPTIONS: Record<'main' | 'development', VariantOptions> = {
    main: { modIdSuffix: '', excludeId: false },
    development: {
        modIdSuffix: '_dev',
        overrideVisibility: 'unlisted',
        excludeId: true,
        titleSuffix: ' - dev_branch',
    },
};

/**
 * Minimal POSIX-style path join for pure planning. Backslashes in the input
 * segments are normalized to '/', which every fs adapter (including Windows
 * Node) accepts.
 */
function joinPosix(...segments: string[]): string {
    return segments
        .filter((segment) => segment !== '')
        .map((segment) => segment.replace(/\\/g, '/').replace(/\/+$/, ''))
        .filter((segment) => segment !== '')
        .join('/');
}

/**
 * Sanitizes a string for use as a directory name, replacing characters that
 * are illegal on Windows filesystems (: ? * " < > | and control chars).
 * @param name The desired directory name
 * @returns {string} The sanitized directory name
 */
export function sanitizeFolderName(name: string): string {
    // eslint-disable-next-line no-control-regex
    const sanitized = name.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
    return sanitized || '_';
}

/**
 * Resolves the build output path for a given variant.
 * @param config The project configuration (outdir must be absolute)
 * @param variant The build variant ('main' or 'development')
 * @returns {string} The absolute path to the build output
 */
export function resolveBuildOutputPath(
    config: IProjectConfig,
    variant: 'main' | 'development',
): string {
    const outDir = config.outdir!;
    const title = config.workshop.title;
    if (variant === 'development') {
        return joinPosix(outDir, `${sanitizeFolderName(title)} - dev_branch`);
    }
    return joinPosix(outDir, sanitizeFolderName(title));
}

/**
 * Collects the mod ids that qualify for a variant: excluded mods never
 * qualify, dev-only mods (build.devOnly) qualify for the development
 * variant only.
 */
export function collectIncludedModIds(
    config: IProjectConfig,
    variant: 'main' | 'development',
): string[] {
    const excludes = config.excludes ?? [];
    return Object.keys(config.mods).filter((modId) => {
        if (excludes.includes(modId)) {
            return false;
        }
        if (variant === 'main' && config.mods[modId].build?.devOnly) {
            return false;
        }
        return true;
    });
}

/**
 * Computes the ordered operations that build one workshop output.
 * @param input The resolved config, build variant and source-tree snapshot
 * @returns {FileOperation[]} The operations the adapter must execute in order
 */
export function planBuild(input: PlanBuildInput): FileOperation[] {
    const {
        config,
        variant,
        workshopTemplateDir,
        projectDir,
        modSourceStates,
        descriptionLines = [],
        previewPngExists,
    } = input;
    const variantOptions = VARIANT_OPTIONS[variant];
    const excludes = config.excludes ?? [];

    const operations: FileOperation[] = [];

    const outPath = resolveBuildOutputPath(config, variant);

    // Reset the output directory
    operations.push({ type: 'removeDir', path: outPath });
    operations.push({ type: 'makeDir', path: outPath });

    // Copy the workshop template
    operations.push({
        type: 'log',
        level: 'info',
        message: `- Copying workshop template...`,
    });
    operations.push({
        type: 'copyTree',
        from: workshopTemplateDir,
        to: outPath,
        excludeIgnoreFile: true,
        ignoreDotFiles: true,
    });

    // Copy the mods. Dev-only mods (build.devOnly) ship in the development
    // output only; the main (production) build skips them.
    const includedModIds = collectIncludedModIds(config, variant);
    for (const modId of includedModIds) {
        const prefixedModId = variantOptions.modIdSuffix
            ? `${modId}${variantOptions.modIdSuffix}`
            : modId;
        const modSrcPath = joinPosix(projectDir, modId);
        const outModsPath = joinPosix(
            outPath,
            'Contents',
            'mods',
            prefixedModId,
        );

        operations.push({
            type: 'log',
            level: 'info',
            message: `- Copying mod '${modId}'...`,
        });
        operations.push({
            type: 'log',
            level: 'verbose',
            message: `Mod source: ${modSrcPath}`,
        });
        operations.push({
            type: 'log',
            level: 'verbose',
            message: `Mod destination: ${outModsPath}`,
        });
        operations.push({
            type: 'copyTree',
            from: modSrcPath,
            to: outModsPath,
            excludeIgnoreFile: true,
            ignoreDotFiles: true,
            ignoreItems: excludes,
        });

        // mod.info handling. The source snapshot is resolved first because
        // even 'skip' needs the target list for the dev id alignment below.
        const state = modSourceStates[modId] ?? {
            branchFolders: [],
            modInfoExists: {},
        };
        const modInfoFlag = config.mods[modId].build?.modInfo;
        const effectiveModInfoFlag = modInfoFlag ?? 'auto-if-missing';

        // Build 42 branch folders (with media/); fall back to the mod root
        // when none survive the excludes filter (Build 41 layout)
        const branchTargets = state.branchFolders.filter(
            (name) => !excludes.includes(name),
        );
        const targets = branchTargets.length > 0 ? branchTargets : [''];

        // Rewrites the id of a source mod.info copied into the development
        // output: the output folder carries the suffixed id (<modId>_dev) and
        // the game requires the mod.info id to match the folder name. Content
        // comes from the source snapshot; without one the planner falls back
        // to copying the file verbatim.
        const pushDevIdPatch = (target: string): boolean => {
            if (!variantOptions.modIdSuffix) {
                return false;
            }
            const content = state.modInfoContent?.[target];
            if (!state.modInfoExists[target] || content === undefined) {
                return false;
            }
            operations.push({
                type: 'log',
                level: 'info',
                message: `- Patching '${modId}' mod.info id to '${prefixedModId}' (development build)...`,
            });
            operations.push({
                type: 'writeFile',
                path: joinPosix(outModsPath, target, 'mod.info'),
                content: patchModInfoId(content, prefixedModId),
            });
            return true;
        };

        if (effectiveModInfoFlag === 'skip') {
            // 'skip' never generates, but a copied mod.info still gets its id
            // aligned with the dev_branch output folder.
            if (variantOptions.modIdSuffix) {
                let patchedAny = false;
                for (const target of targets) {
                    if (pushDevIdPatch(target)) {
                        patchedAny = true;
                    }
                }
                if (!patchedAny) {
                    operations.push({
                        type: 'log',
                        level: 'info',
                        message: `- Skipping '${modId}' mod.info generation (build.modInfo: "skip")...`,
                    });
                }
            } else {
                operations.push({
                    type: 'log',
                    level: 'info',
                    message: `- Skipping '${modId}' mod.info generation (build.modInfo: "skip")...`,
                });
            }
            continue;
        }

        for (const target of targets) {
            const modInfoPath = joinPosix(outModsPath, target, 'mod.info');

            if (pushDevIdPatch(target)) {
                continue;
            }

            if (
                effectiveModInfoFlag === 'auto-if-missing' &&
                state.modInfoExists[target]
            ) {
                operations.push({
                    type: 'log',
                    level: 'info',
                    message: `- Skipping '${modId}' mod.info generation (already exists, build.modInfo: "auto-if-missing")...`,
                });
            } else {
                operations.push({
                    type: 'log',
                    level: 'info',
                    message: `- Generating '${modId}' mod.info...`,
                });
                operations.push({
                    type: 'writeFile',
                    path: modInfoPath,
                    content: modInfoText(modId, config, prefixedModId),
                });
            }
        }
    }

    // Copy the workshop preview.png
    const projectPreviewPath = joinPosix(projectDir, 'workshop', 'preview.png');
    if (previewPngExists) {
        operations.push({
            type: 'log',
            level: 'info',
            message: `- Copying workshop 'preview.png'...`,
        });
        operations.push({
            type: 'copyFile',
            from: projectPreviewPath,
            to: joinPosix(outPath, 'preview.png'),
        });
    } else {
        operations.push({
            type: 'log',
            level: 'warn',
            message: `- No workshop 'preview.png' found as '${projectPreviewPath}'...`,
        });
    }

    // Generate the workshop.txt
    operations.push({
        type: 'log',
        level: 'info',
        message: `- Generating 'workshop.txt'...`,
    });
    operations.push({
        type: 'writeFile',
        path: joinPosix(outPath, 'workshop.txt'),
        content: workshopText(config, {
            descriptionLines,
            overrideVisibility: variantOptions.overrideVisibility,
            excludeId: variantOptions.excludeId,
            titleSuffix: variantOptions.titleSuffix,
        }),
    });

    return operations;
}
