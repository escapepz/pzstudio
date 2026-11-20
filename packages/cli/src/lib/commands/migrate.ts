import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { info, log, verbose, warn } from '../logger';
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

    Usage:
        pzstudio migrate`,
);

/**
 * The mod fields the tool's own contract requires of every mod — mirrored
 * from the validator's mod checks (`packages/core/src/validation.ts`: name
 * must be a string, description a string or array) and the project schema's
 * mod definition (`"required": ["name", "description"]`). The id is
 * deliberately NOT in this list: it is the project.json key, never synced
 * from mod.info (d08-U6).
 */
const REQUIRED_MOD_INFO_FIELDS = ['name', 'description'] as const;

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
        // Whether the legacy-shape upgrade ran for this file — only then is
        // the written project.json "migrate's own output" (d16-F1).
        let wasUpgraded = false;
        const projectCheck = migration.checkProject(project);
        if (projectCheck.needsMigration) {
            info(`- Migrating project.json: ${projectCheck.reason}`);
            project = migration.upgradeProject(project, {
                // stderr, per the CLI-2 stream contract: every legacy value
                // the upgrade moved (or deliberately kept) is announced —
                // migration must never be silent about user data (d16-B2).
                onNotice: (message, level) =>
                    level === 'warn' ? warn(message) : info(`- ${message}`),
            });
            wasUpgraded = true;
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

                // Sync fields from mod.info to project.json. A field is
                // imported when the config does not carry a value yet — and
                // an EMPTY STRING counts as "not carried" (d08-B4): new/add
                // write `description: ''` (and similar placeholders) into
                // fresh mod configs, and that placeholder must not swallow
                // the authored legacy content. (The '' does NOT come from
                // the parser — parseModInfoText drops empty collections.)
                for (const key in parsedModInfo) {
                    if (key === 'id') continue; // Don't sync ID as it's the key in project.json

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

                // d16-U5: a legacy mod.info that lacks the fields the tool's
                // own contract requires of every mod must not import
                // silently — a typo'd or gutted file would otherwise be
                // indistinguishable from a complete one, with "Synced data
                // from ..." as the only signal. Import stays identical: what
                // the file carries still syncs and the command still exits 0.
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

        // d16-F1: migrate must not certify output it would itself reject.
        // A legacy slug root id, for example, moves verbatim to
        // workshop.id and then bricks every later command ("Field \"id\"
        // must be a number", doctor exit 1) behind a silent "Migration
        // complete.". When the upgrade ran, the final shape goes through
        // the SAME validator every later command uses
        // (readProjectConfig / loadProject); an invalid result is a [WARN]
        // naming the failing field(s) with the validator's own message.
        // The file stays written and the exit stays 0 — the d15-B5 owner
        // decision on migrate's exit semantics is untouched.
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
