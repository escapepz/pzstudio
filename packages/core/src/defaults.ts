/**
 * Pure defaulting/normalization helpers for project configuration.
 *
 * These live in core because every loader (CLI readProjectConfig, the future
 * loadProject contract, the web workspace) must normalize a raw parsed
 * project.json the same way before validating it.
 */
import type { IProjectConfig } from './project';

/**
 * Fills the documented defaults into a raw project config object (mutating
 * it) and returns it typed. Passing an optional onVerbose hook keeps the
 * host's diagnostic channel; core itself never prints.
 *
 * @param config The raw parsed config (any shape, may be null/undefined)
 * @param onVerbose Optional sink for defaulting diagnostics
 * @returns {IProjectConfig} The same object with defaults applied
 */
export function applyProjectDefaults(
    config: any,
    onVerbose?: (message: string) => void,
): IProjectConfig {
    const verbose = onVerbose ?? ((_message: string) => {});
    if (!config) return config;

    // Default workshop settings
    if (!config.workshop) config.workshop = {};
    if (config.excludes === undefined) {
        verbose(`Defaulting excludes to empty list`);
        config.excludes = [];
    }

    // Default mods settings
    if (config.mods) {
        for (const modId in config.mods) {
            const mod = config.mods[modId];
            if (mod.poster === undefined) {
                verbose(`Mod '${modId}' defaulting poster to: poster.png`);
                mod.poster = 'poster.png';
            }
            if (mod.icon === undefined) {
                verbose(`Mod '${modId}' defaulting icon to: icon.png`);
                mod.icon = 'icon.png';
            }
            if (!mod.build) mod.build = {};
            if (mod.build.modInfo === undefined) {
                mod.build.modInfo = 'auto-if-missing';
            }
        }
    }

    return config as IProjectConfig;
}

/**
 * Converts a human title into a filesystem-safe Unix-compatible mod id:
 * lowercased, spaces collapsed to underscores, everything outside
 * [a-z0-9_] stripped, camelCase preserved.
 */
export function formatTitleToId(title: string): string {
    return title
        .toLowerCase()
        .replace(/\s+/g, '_') // Replace spaces with underscores
        .replace(/[^a-z0-9_]/g, ''); // Remove any other special characters
}
