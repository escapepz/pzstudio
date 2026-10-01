const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Builds the throwaway environment the real-VS-Code integration tests run
 * against: a fixture project opened as the workspace, plus a fake home so
 * the CLI api inside the extension host never touches the real ~/.pzstudio.
 * Paths reach the tests through env vars (see .vscode-test.js).
 */

const PROJECT_TITLE = 'Ext Host Build';
const MOD_ID = 'ext_host_mod';

function writeFixtureProject(projectDir) {
    fs.writeFileSync(
        path.join(projectDir, 'project.json'),
        JSON.stringify({
            workshop: {
                title: PROJECT_TITLE,
                visibility: 'public',
                tags: ['Build 42'],
            },
            mods: {
                [MOD_ID]: {
                    name: 'Ext Host Mod',
                    description: 'Built inside the extension host.',
                },
            },
            excludes: [],
            schemaVersion: 2,
        }),
        'utf8',
    );
    fs.mkdirSync(path.join(projectDir, MOD_ID, '42', 'media', 'lua'), {
        recursive: true,
    });
    fs.writeFileSync(
        path.join(projectDir, MOD_ID, '42', 'media', 'lua', 'main.lua'),
        '-- built by the extension host integration test\n',
        'utf8',
    );
    fs.mkdirSync(path.join(projectDir, 'workshop'), { recursive: true });
    fs.writeFileSync(
        path.join(projectDir, 'workshop', 'description.txt'),
        'Extension host integration fixture',
        'utf8',
    );
}

/**
 * Seeds the workshop template cache inside the fake home so the api-driven
 * build never attempts a real git clone. The cache location mirrors the
 * CLI's getCachePathFromUrl for the default template URL — keep in sync
 * with DEFAULT_TEMPLATES in packages/core/src/constants.ts. The content is
 * the bundled legacy snapshot the CLI build copied from the submodules.
 */
function seedWorkshopTemplateCache(home) {
    const legacyWorkshop = path.join(
        __dirname,
        '..',
        '..',
        'cli',
        'dist',
        '.template-legacy',
        '.template-workshop',
    );
    if (!fs.existsSync(path.join(legacyWorkshop, 'Contents'))) {
        throw new Error(
            'packages/cli/dist/.template-legacy is empty — build the CLI (pnpm --filter @pzstudio/cli... build) after checking out the submodules.',
        );
    }
    const cache = path.join(
        home,
        '.pzstudio',
        'templates',
        'escapepz',
        'pzstudio-template-workshop',
    );
    fs.cpSync(legacyWorkshop, cache, { recursive: true });
    fs.rmSync(path.join(cache, '.git'), { force: true, recursive: true });
    fs.mkdirSync(path.join(cache, '.git'), { recursive: true });
}

function removeDirBestEffort(dir) {
    try {
        fs.rmSync(dir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
        });
    } catch {
        // OS temp leftovers are acceptable; never fail the run for cleanup.
    }
}

function createIntegrationFixture() {
    const projectDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'pzstudio-ext-fixture-'),
    );
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pzstudio-ext-home-'));
    writeFixtureProject(projectDir);
    seedWorkshopTemplateCache(home);
    // The VS Code process is gone by the time the runner exits.
    process.once('exit', () => {
        removeDirBestEffort(projectDir);
        removeDirBestEffort(home);
    });
    return { projectDir, home };
}

module.exports = { createIntegrationFixture, PROJECT_TITLE, MOD_ID };
