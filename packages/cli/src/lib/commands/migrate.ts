import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { info, log, verbose } from '../logger';
import {
    updateProjectConfig,
    findProjectDir,
    resolveModInfoTargets,
    migrationHostOptions,
} from '../helper';
import { migration } from '@pzstudio/core';
import { writeGlobalConfig, getConfigPath } from '../templateManager';
import { existsSync, readFileSync } from 'fs';
import path, { join } from 'path';

addHelp(
    'migrate',
    `Upgrade legacy project.json and config.json files to the current shape without losing unknown fields.
    
    Usage:
        pzstudio migrate`,
);

/**
 * Handles the migrate command.
 */
export async function migrateCmd() {
    log('\nChecking for legacy file shapes...\n');

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

    // An empty project.json is NOT a valid project config (unlike an empty
    // config.json), so it must fail loudly instead of parsing as {}.
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

    // 1. Migrate config.json
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
        info('  → config.json upgraded successfully.');
    } else {
        log('- config.json is already up to date.');
    }

    // 2. Migrate project.json (if it exists). Non-throwing discovery: the
    // migrate contract is to work outside a project (global config only).
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
        const projectCheck = migration.checkProject(project);
        if (projectCheck.needsMigration) {
            info(`- Migrating project.json: ${projectCheck.reason}`);
            project = migration.upgradeProject(project);
            projectModified = true;
        }

        // 3. Migrate mod.info files into project.json
        const mods = project.mods || {};
        for (const modId in mods) {
            const rootModInfoPath = join(projectRoot!, modId, 'mod.info');
            const modInfoFiles: string[] = [];

            if (existsSync(rootModInfoPath)) {
                modInfoFiles.push(rootModInfoPath);
            } else {
                // Check Build 42 branch folders
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

                // Sync fields from mod.info to project.json if missing or different
                for (const key in parsedModInfo) {
                    if (key === 'id') continue; // Don't sync ID as it's the key in project.json

                    const value = (parsedModInfo as any)[key];
                    if (modConfig[key] === undefined) {
                        verbose(
                            `  + Importing '${key}' from mod.info into project.json`,
                        );
                        modConfig[key] = value;
                        modModified = true;
                    }
                }

                if (modModified) {
                    info(
                        `- Synced data from ${modId}/${modInfoFiles.length > 1 ? path.basename(path.dirname(modInfoPath)) + '/' : ''}mod.info into project.json`,
                    );
                    projectModified = true;
                }

                // If we found one and synced, we can skip other branch folders for the same mod
                // since they are expected to be identical.
                if (modModified) break;
            }
        }

        if (projectModified) {
            updateProjectConfig(projectPath, project, true);
            info('  → project.json upgraded and synced successfully.');
        } else {
            log('- project.json is already up to date.');
        }
    } else {
        log('- No project.json found.');
    }

    info('\nMigration complete.');
}

registerCommand({
    name: 'migrate',
    summary: 'Upgrade legacy config.json and project.json files.',
    run: () => migrateCmd(),
});
