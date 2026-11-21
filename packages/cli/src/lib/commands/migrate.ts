import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { info, log, verbose, warn } from '../logger';
import { hasFlag } from '../args';
import { printJsonEnvelope } from '../json';
import {
    updateProjectConfig,
    findProjectDir,
    resolveModInfoTargets,
    migrationHostOptions,
} from '../helper';
import { migration, validateProject, ValidationContext } from '@pzstudio/core';
import { writeGlobalConfig, getConfigPath } from '../templateManager';
import { existsSync, readFileSync } from 'fs';
import path, { join } from 'path';

addHelp(
    'migrate',
    `Upgrade legacy project.json and config.json files to the current shape without losing unknown fields.

    Usages:
        pzstudio migrate          - Upgrade legacy file shapes.
        pzstudio migrate --json   - Print a machine-readable envelope instead.`,
);

const REQUIRED_MOD_INFO_FIELDS = ['name', 'description'] as const;

export async function migrateCmd() {
    const json = hasFlag('json');
    if (!json) {
        log('\nChecking for legacy file shapes...\n');
    }
    let configMigrated = false;
    let projectMigrated = false;
    let syncedModInfoFiles = 0;

    const readConfigJsonOrEmpty = (filePath: string) => {
        const content = readFileSync(filePath, 'utf8');
        try {
            return content.trim() ? JSON.parse(content) : {};
        } catch (err) {
            throw new Error(
                `Failed to parse '${filePath}': ${(err as Error).message}. Fix the JSON syntax and run 'pzstudio migrate' again.`,
                { cause: err },
            );
        }
    };

    const readProjectJsonStrict = (filePath: string) => {
        const content = readFileSync(filePath, 'utf8');
        try {
            return JSON.parse(content);
        } catch (err) {
            throw new Error(
                `Failed to parse '${filePath}': ${(err as Error).message}. Fix the JSON syntax and run 'pzstudio migrate' again.`,
                { cause: err },
            );
        }
    };

    const configPath = getConfigPath();
    const config = existsSync(configPath)
        ? readConfigJsonOrEmpty(configPath)
        : {};
    const configCheck = migration.checkConfig(config);
    if (configCheck.needsMigration) {
        info(`- Migrating config.json: ${configCheck.reason}`);
        const upgradedConfig = migration.upgradeConfig(
            config,
            migrationHostOptions(),
        );
        writeGlobalConfig(upgradedConfig);
        configMigrated = true;
        info('  → config.json upgraded successfully.');
    } else if (!json) {
        log('- config.json is already up to date.');
    }

    const projectRoot = findProjectDir();
    const projectPath = projectRoot
        ? join(projectRoot, 'project.json')
        : undefined;
    let project =
        projectPath && existsSync(projectPath)
            ? readProjectJsonStrict(projectPath)
            : undefined;

    if (project) {
        let projectModified = false;
        let wasUpgraded = false;
        const projectCheck = migration.checkProject(project);
        if (projectCheck.needsMigration) {
            info(`- Migrating project.json: ${projectCheck.reason}`);
            project = migration.upgradeProject(project, {
                onNotice: (message, level) =>
                    level === 'warn' ? warn(message) : info(`- ${message}`),
            });
            wasUpgraded = true;
            projectModified = true;
        }

        const mods = project.mods || {};
        for (const modId in mods) {
            const rootModInfoPath = join(projectRoot!, modId, 'mod.info');
            const modInfoFiles: string[] = [];

            if (existsSync(rootModInfoPath)) {
                modInfoFiles.push(rootModInfoPath);
            } else {
                const targets = resolveModInfoTargets(modId, projectRoot);
                for (const targetDir of targets) {
                    const branchModInfoPath = join(targetDir, 'mod.info');
                    if (existsSync(branchModInfoPath)) {
                        modInfoFiles.push(branchModInfoPath);
                    }
                }
            }

            for (const modInfoPath of modInfoFiles) {
                verbose(
                    `Checking mod.info for mod '${modId}' at '${modInfoPath}'...`,
                );
                const content = readFileSync(modInfoPath, 'utf8');
                const parsedModInfo = migration.parseModInfo(content);

                const modConfig = project.mods[modId];
                let modModified = false;

                for (const key in parsedModInfo) {
                    if (key === 'id') continue;

                    const value = (parsedModInfo as any)[key];
                    const existing = (modConfig as any)[key];
                    if (existing === undefined || existing === '') {
                        verbose(
                            `  + Importing '${key}' from mod.info into project.json`,
                        );
                        modConfig[key] = value;
                        modModified = true;
                    }
                }

                const missingRequired = REQUIRED_MOD_INFO_FIELDS.filter(
                    (field) => (parsedModInfo as any)[field] === undefined,
                );
                if (missingRequired.length > 0) {
                    warn(
                        `Legacy mod.info at '${modInfoPath}' is missing required field(s): ${missingRequired.join(', ')}. Fix the file and run 'pzstudio migrate' again.`,
                    );
                }

                if (modModified) {
                    info(
                        `- Synced data from ${modId}/${modInfoFiles.length > 1 ? path.basename(path.dirname(modInfoPath)) + '/' : ''}mod.info into project.json`,
                    );
                    syncedModInfoFiles += 1;
                    projectModified = true;
                }

                if (modModified) break;
            }
        }

        if (projectModified) {
            updateProjectConfig(projectPath, project, true);
            info('  → project.json upgraded and synced successfully.');
        } else if (!json) {
            log('- project.json is already up to date.');
        }
        projectMigrated = projectModified;

        if (wasUpgraded) {
            const context = new ValidationContext(path.basename(projectPath));
            validateProject(project, context);
            if (context.hasErrors()) {
                warn(
                    `Migrated project.json still fails validation: ${context
                        .getErrors()
                        .map((error) => `${error.location} — ${error.problem}`)
                        .join(
                            '; ',
                        )}. Edit project.json manually or re-run with a numeric id — other commands will keep rejecting this project until it validates.`,
                );
            }
        }
    } else if (!json) {
        log('- No project.json found.');
    }

    info('\nMigration complete.');

    if (json) {
        printJsonEnvelope('migrate', {
            configMigrated,
            projectMigrated,
            syncedModInfoFiles,
        });
    }
}

registerCommand({
    name: 'migrate',
    summary: 'Upgrade legacy config.json and project.json files.',
    flags: [{ name: 'json' }],
    run: () => migrateCmd(),
});
