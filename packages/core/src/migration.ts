import { IProjectConfig, IModConfig } from './project';
import { DEFAULT_TEMPLATES } from './constants';
import { parseModInfoText } from './modInfoParser';

/**
 * Host-provided fallbacks for config.json migration. The migration logic
 * itself is pure; the adapter supplies how to read the legacy backup file
 * and what the platform default outdir is.
 */
export interface MigrationHostOptions {
    /** Reads the legacy ~/.pzstudio/.pzstudio.bak outdir, if present. */
    readBackupOutdir?: () => string | undefined;
    /** Outdir used when neither the config nor the backup provides one. */
    defaultOutdir?: string;
}

/**
 * Result of a migration check.
 */
export interface MigrationResult {
    needsMigration: boolean;
    reason?: string;
    upgradedConfig?: any;
}

/**
 * Options for upgradeProject. Core never prints: decisions the host should
 * surface (a moved root field, a kept deprecated field) travel out through
 * this sink — the CLI migrate command prints them on stderr, the in-memory
 * loader warns, the engine chain records them in MigratedProject.migrations.
 */
export interface MigrationUpgradeOptions {
    onNotice?: (message: string, level: 'info' | 'warn') => void;
}

/**
 * Helpers for detecting and upgrading legacy file shapes.
 */
export const migration = {
    checkProject: (config: any): MigrationResult => {
        const issues: string[] = [];

        if ('title' in config) issues.push('root "title" is deprecated');
        if ('authors' in config)
            issues.push(
                'root "authors" is deprecated (move the values to the mod-level "author" field)',
            );
        if ('id' in config) issues.push('root "id" is deprecated');

        if (config.workshop && 'excludes' in config.workshop) {
            issues.push('"workshop.excludes" has moved to root');
        }

        if (issues.length > 0) {
            return {
                needsMigration: true,
                reason: issues.join(', '),
            };
        }

        return { needsMigration: false };
    },

    upgradeProject: (
        config: any,
        options: MigrationUpgradeOptions = {},
    ): IProjectConfig => {
        const upgraded = JSON.parse(JSON.stringify(config));

        if (!upgraded.workshop) upgraded.workshop = {};

        if ('id' in upgraded && upgraded.workshop.id === undefined) {
            upgraded.workshop.id = upgraded.id;
        }
        delete upgraded.id;

        if ('title' in upgraded && upgraded.workshop.title === undefined) {
            upgraded.workshop.title = upgraded.title;
        }
        delete upgraded.title;

        if ('authors' in upgraded) {
            const authors = upgraded.authors;
            const modIds =
                upgraded.mods && typeof upgraded.mods === 'object'
                    ? Object.keys(upgraded.mods)
                    : [];
            const onlyMod =
                modIds.length === 1 ? upgraded.mods[modIds[0]] : undefined;
            const movableShape =
                typeof authors === 'string' ||
                (Array.isArray(authors) &&
                    authors.every((entry: any) => typeof entry === 'string'));

            if (
                onlyMod &&
                typeof onlyMod === 'object' &&
                onlyMod.author === undefined &&
                movableShape
            ) {
                onlyMod.author = Array.isArray(authors)
                    ? authors.join(', ')
                    : authors;
                delete upgraded.authors;
                options.onNotice?.(
                    `moved root authors to mod '${modIds[0]}'`,
                    'info',
                );
            } else {
                options.onNotice?.(
                    'kept deprecated root "authors" in place — move the values to a mod-level "author" field and remove the root field',
                    'warn',
                );
            }
        }

        if (upgraded.workshop.excludes !== undefined) {
            if (
                upgraded.excludes === undefined ||
                (Array.isArray(upgraded.excludes) &&
                    upgraded.excludes.length === 0)
            ) {
                upgraded.excludes = upgraded.workshop.excludes;
            } else if (Array.isArray(upgraded.excludes)) {
                upgraded.excludes = Array.from(
                    new Set([
                        ...upgraded.excludes,
                        ...upgraded.workshop.excludes,
                    ]),
                );
            }
            delete upgraded.workshop.excludes;
        }

        if (upgraded.excludes === undefined) {
            upgraded.excludes = [];
        }

        delete upgraded.useSymlinks;

        return upgraded as IProjectConfig;
    },

    checkConfig: (config: any): MigrationResult => {
        const issues: string[] = [];
        if (config.useSymlinks === undefined)
            issues.push('missing "useSymlinks"');

        if (!config.templates || Object.keys(config.templates).length === 0) {
            issues.push('missing or empty "templates"');
        }

        if (issues.length > 0) {
            return {
                needsMigration: true,
                reason: issues.join(', '),
            };
        }
        return { needsMigration: false };
    },

    upgradeConfig: (
        config: any,
        hostOptions: MigrationHostOptions = {},
    ): any => {
        const upgraded = JSON.parse(JSON.stringify(config));

        if (upgraded.useSymlinks === undefined) {
            upgraded.useSymlinks = true;
        }

        if (
            !upgraded.templates ||
            Object.keys(upgraded.templates).length === 0
        ) {
            upgraded.templates = { ...DEFAULT_TEMPLATES };
        } else {
            upgraded.templates = {
                ...DEFAULT_TEMPLATES,
                ...upgraded.templates,
            };
        }

        if (!upgraded.outdir) {
            try {
                const backup = hostOptions.readBackupOutdir?.();
                if (backup) upgraded.outdir = backup;
            } catch {}
            if (!upgraded.outdir && hostOptions.defaultOutdir) {
                upgraded.outdir = hostOptions.defaultOutdir;
            }
        }

        return upgraded;
    },

    upgradeModInfo: (content: string): string => {
        const lines = content
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const map = new Map<string, string>();

        lines.forEach((line) => {
            const index = line.indexOf('=');
            if (index !== -1) {
                const key = line.substring(0, index).trim();
                const value = line.substring(index + 1).trim();
                map.set(key, value);
            }
        });

        if (!map.has('id')) map.set('id', 'new_mod');
        if (!map.has('name')) map.set('name', 'New Mod');
        if (!map.has('description'))
            map.set('description', 'A Project Zomboid mod.');

        return Array.from(map.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');
    },
    parseModInfo: (content: string): Partial<IModConfig> & { id?: string } =>
        parseModInfoText(content),
};
