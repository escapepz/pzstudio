import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { info, log, verbose } from '../logger';
import { projectDir, updateProjectConfig } from '../helper';
import { validateProject, ValidationContext } from '@pzstudio/core';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { IModConfig, IProjectConfig } from '@pzstudio/core';

addHelp(
    'modconfig',
    `View or change a mod's configuration in project.json without editing the file by hand.

    Usages:
        pzstudio modconfig <modId>                       Show the mod's current configuration
        pzstudio modconfig <modId> include               Build the mod in every output (default)
        pzstudio modconfig <modId> devonly               Build the mod in the dev_branch output only
        pzstudio modconfig <modId> exclude               Skip the mod in every build
        pzstudio modconfig <modId> set <key> <value>     Set a field (array fields split on commas)
        pzstudio modconfig <modId> unset <key>           Remove a field

    Keys: name, description, author, modversion, category, url, icon, poster,
    versionMin, versionMax, require, incompatible, loadModAfter, loadModBefore,
    pack, tiledef, modInfo (build.modInfo: auto | skip | auto-if-missing).`,
);

/** Fields stored as string arrays (values split on commas). */
const ARRAY_KEYS = new Set([
    'description',
    'poster',
    'require',
    'incompatible',
    'loadModAfter',
    'loadModBefore',
    'pack',
    'tiledef',
]);

/** Fields stored as plain strings. modInfo maps to build.modInfo. */
const STRING_KEYS = new Set([
    'name',
    'author',
    'modversion',
    'category',
    'url',
    'icon',
    'versionMin',
    'versionMax',
    'modInfo',
]);

const KNOWN_KEYS = new Set([...ARRAY_KEYS, ...STRING_KEYS]);
const MODINFO_VALUES = new Set(['auto', 'skip', 'auto-if-missing']);

/** Fields required by the project.json schema — unset would break validation. */
const REQUIRED_KEYS = new Set(['name', 'description']);

/**
 * Reads project.json raw (no defaults applied) so an edit only touches the
 * fields it actually changes instead of materializing defaults for every mod.
 */
function readRawProjectConfig(): { path: string; config: IProjectConfig } {
    const path = join(projectDir(), 'project.json');
    if (!existsSync(path)) {
        throw new Error(
            'You must execute this command within a project directory!',
        );
    }
    let config: any;
    try {
        config = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        throw new Error(
            `Failed to parse 'project.json': ${(err as Error).message}. Fix the JSON syntax and try again.`,
            { cause: err },
        );
    }
    return { path, config: config as IProjectConfig };
}

/** Throws when the project.json is structurally invalid after an edit. */
function assertValidConfig(config: IProjectConfig): void {
    const context = new ValidationContext('project.json');
    validateProject(config, context);
    if (context.hasErrors()) {
        throw new Error(
            `Validation failed for project.json:\n${context.formatErrors()}`,
        );
    }
}

function getModOrThrow(config: IProjectConfig, modId: string): IModConfig {
    const mod = config.mods[modId];
    if (!mod) {
        throw new Error(
            `Mod '${modId}' is not in project.json. Known mods: ${
                Object.keys(config.mods).join(', ') || '(none)'
            }`,
        );
    }
    return mod;
}

/** Resolves the mod's build state: excluded > dev only > included. */
export function modBuildState(
    config: IProjectConfig,
    modId: string,
): 'included' | 'dev only' | 'excluded' {
    if (config.excludes?.includes(modId)) {
        return 'excluded';
    }
    if (config.mods[modId]?.build?.devOnly === true) {
        return 'dev only';
    }
    return 'included';
}

function showMod(config: IProjectConfig, modId: string): void {
    const mod = getModOrThrow(config, modId);
    log(`Mod '${modId}' (${modBuildState(config, modId)}):`);
    for (const [key, value] of Object.entries(mod)) {
        if (key === 'build') {
            for (const [buildKey, buildValue] of Object.entries(
                (value as Record<string, unknown>) ?? {},
            )) {
                log(`    build.${buildKey} = ${String(buildValue)}`);
            }
            continue;
        }
        const display = Array.isArray(value) ? value.join(', ') : String(value);
        log(`    ${key} = ${display}`);
    }
}

function applyInclude(config: IProjectConfig, modId: string): boolean {
    const mod = getModOrThrow(config, modId);
    let changed = false;
    if (config.excludes?.includes(modId)) {
        config.excludes = config.excludes.filter((id) => id !== modId);
        changed = true;
    }
    if (mod.build?.devOnly !== undefined) {
        delete mod.build.devOnly;
        changed = true;
    }
    return changed;
}

function applyExclude(config: IProjectConfig, modId: string): boolean {
    getModOrThrow(config, modId);
    if (config.excludes?.includes(modId)) {
        return false;
    }
    config.excludes = [...(config.excludes ?? []), modId];
    // Excluded wins over dev-only: keep the state invariant.
    const mod = config.mods[modId];
    if (mod.build?.devOnly !== undefined) {
        delete mod.build.devOnly;
    }
    return true;
}

function applyDevOnly(config: IProjectConfig, modId: string): boolean {
    const mod = getModOrThrow(config, modId);
    if (!mod.build) {
        mod.build = {};
    }
    config.excludes = (config.excludes ?? []).filter((id) => id !== modId);
    if (mod.build.devOnly === true) {
        return false;
    }
    mod.build.devOnly = true;
    return true;
}

/**
 * Applies `set`: coerces the raw value to the field's shape and returns the
 * previous value (undefined when the field was absent).
 */
function applySet(
    mod: IModConfig,
    key: string,
    rawValue: string,
): string | string[] | undefined {
    if (!KNOWN_KEYS.has(key)) {
        throw new Error(
            `Unknown mod config key '${key}'. Known keys: ${[...KNOWN_KEYS].join(', ')}`,
        );
    }

    if (key === 'modInfo') {
        if (!MODINFO_VALUES.has(rawValue)) {
            throw new Error(
                `Invalid modInfo value '${rawValue}'. Expected one of: ${[...MODINFO_VALUES].join(', ')}`,
            );
        }
        if (!mod.build) {
            mod.build = {};
        }
        const previous = mod.build.modInfo;
        mod.build.modInfo = rawValue as 'auto' | 'skip' | 'auto-if-missing';
        return previous;
    }

    if (ARRAY_KEYS.has(key)) {
        const value = rawValue
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '');
        const previous = (mod as any)[key];
        (mod as any)[key] = value;
        return previous;
    }

    const previous = (mod as any)[key];
    (mod as any)[key] = rawValue;
    return previous;
}

function applyUnset(
    mod: IModConfig,
    key: string,
): string | string[] | undefined {
    if (!KNOWN_KEYS.has(key)) {
        throw new Error(
            `Unknown mod config key '${key}'. Known keys: ${[...KNOWN_KEYS].join(', ')}`,
        );
    }
    if (REQUIRED_KEYS.has(key)) {
        throw new Error(
            `Key '${key}' is required by project.json and cannot be unset.`,
        );
    }
    if (key === 'modInfo') {
        const previous = mod.build?.modInfo;
        if (mod.build && previous !== undefined) {
            delete mod.build.modInfo;
        }
        return previous;
    }
    const previous = (mod as any)[key];
    if (previous !== undefined) {
        delete (mod as any)[key];
    }
    return previous;
}

function formatValue(value: string | string[] | undefined): string {
    if (value === undefined) return '(not set)';
    return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Handles the modconfig command.
 */
export async function modconfigCmd(positionals: string[]) {
    const [modId, action = 'show', key, ...valueParts] = positionals;

    if (!modId) {
        throw new Error(
            'Usage: pzstudio modconfig <modId> [include|devonly|exclude|set <key> <value>|unset <key>]',
        );
    }

    const { path, config } = readRawProjectConfig();
    getModOrThrow(config, modId);

    // 'show' returns above; every other branch assigns before reading.
    let changed: boolean;
    switch (action) {
        case 'show':
            showMod(config, modId);
            return;
        case 'include':
            changed = applyInclude(config, modId);
            info(
                changed
                    ? `Mod '${modId}' is now included in every build.`
                    : `Mod '${modId}' was already included.`,
            );
            break;
        case 'devonly':
            changed = applyDevOnly(config, modId);
            info(
                changed
                    ? `Mod '${modId}' is now built in the dev_branch output only.`
                    : `Mod '${modId}' was already dev-only.`,
            );
            break;
        case 'exclude':
            changed = applyExclude(config, modId);
            info(
                changed
                    ? `Mod '${modId}' is now excluded from every build.`
                    : `Mod '${modId}' was already excluded.`,
            );
            break;
        case 'set': {
            if (!key) {
                throw new Error(
                    'Usage: pzstudio modconfig <modId> set <key> <value>',
                );
            }
            const rawValue = valueParts.join(' ').trim();
            if (!rawValue) {
                throw new Error(
                    `Missing value for '${key}'. Use 'unset' to remove a field instead.`,
                );
            }
            const mod = getModOrThrow(config, modId);
            const previous = applySet(mod, key, rawValue);
            changed = true;
            const current =
                key === 'modInfo' ? mod.build?.modInfo : (mod as any)[key];
            verbose(
                `Setting '${key}': ${formatValue(previous)} -> ${formatValue(current)}`,
            );
            break;
        }
        case 'unset': {
            if (!key) {
                throw new Error(
                    'Usage: pzstudio modconfig <modId> unset <key>',
                );
            }
            const mod = getModOrThrow(config, modId);
            const previous = applyUnset(mod, key);
            changed = true;
            info(
                previous === undefined
                    ? `Key '${key}' was not set on mod '${modId}'.`
                    : `Unset '${key}' (was: ${formatValue(previous)}).`,
            );
            break;
        }
        default:
            throw new Error(
                `Unknown modconfig action '${action}'. Expected: include, devonly, exclude, set, unset (or no action to show).`,
            );
    }

    if (!changed) {
        return;
    }

    assertValidConfig(config);
    updateProjectConfig(path, config, true);
    log(`project.json updated.`);
}

registerCommand({
    name: 'modconfig',
    summary: 'View or change a mod configuration without editing project.json.',
    positionals: [
        { name: 'modId', required: true },
        { name: 'action', required: false, variadic: true },
    ],
    run: (ctx) => modconfigCmd(ctx.positionals),
});
