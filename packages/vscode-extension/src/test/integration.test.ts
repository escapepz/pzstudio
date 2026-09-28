import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runCLI, setProjectDir } from 'pzstudio-cli/api';

/**
 * Desktop integration tests running inside a real VS Code extension host
 * (launched by @vscode/test-electron via the .vscode-test.js config). This
 * complements the vitest suites, which run against a mocked vscode module:
 * here every vscode API call, command registration and the CLI api bridge
 * are the real thing.
 */
describe('PZ Studio extension (real VS Code host)', () => {
    const projectDir = process.env.PZSTUDIO_TEST_PROJECT_DIR ?? '';
    const fakeHome = process.env.PZSTUDIO_TEST_FAKE_HOME ?? '';
    const PROJECT_TITLE = 'Ext Host Build';
    const MOD_ID = 'ext_host_mod';

    let extension: vscode.Extension<unknown>;

    before(async () => {
        const found = vscode.extensions.getExtension('escapepz.pzstudio42');
        if (!found) {
            throw new Error(
                'The PZ Studio extension is not available in the test host.',
            );
        }
        extension = found;
        await extension.activate();
    });

    it('activates on a workspace containing project.json', () => {
        assert.strictEqual(extension.isActive, true);
    });

    it('registers every command contributed by the manifest', async () => {
        const registered = new Set(await vscode.commands.getCommands(true));
        const contributed = extension.packageJSON.contributes.commands;
        assert.ok(Array.isArray(contributed) && contributed.length > 0);
        for (const entry of contributed) {
            assert.ok(
                registered.has(entry.command),
                `Command not registered: ${entry.command}`,
            );
        }
    });

    it('exposes the pzstudio task definitions through the task provider', async () => {
        const tasks = await vscode.tasks.fetchTasks({ type: 'pzstudio' });
        const targets = tasks.map((task) => task.definition.target);
        for (const expected of ['production', 'development', 'clean']) {
            assert.ok(
                targets.includes(expected),
                `Missing task target: ${expected} (got ${targets.join(', ')})`,
            );
        }
    });

    it('refreshes the project explorer without throwing', async () => {
        await vscode.commands.executeCommand('pzstudio.explorer.refresh');
    });

    it('builds the fixture project through the api inside the extension host', async () => {
        assert.ok(projectDir, 'fixture project dir env is missing');
        assert.ok(fakeHome, 'fixture fake home env is missing');

        setProjectDir(projectDir);
        // Explicit empty flags: runCLI must not depend on the VS Code host's
        // own process.argv (the C2 contract).
        await runCLI('build', [], { flags: [] });

        const workshopTxt = path.join(
            fakeHome,
            'Zomboid',
            'Workshop',
            PROJECT_TITLE,
            'workshop.txt',
        );
        assert.ok(
            fs.existsSync(workshopTxt),
            `Build output missing: ${workshopTxt}`,
        );
        assert.ok(
            fs.existsSync(
                path.join(
                    fakeHome,
                    'Zomboid',
                    'Workshop',
                    PROJECT_TITLE,
                    'Contents',
                    'mods',
                    MOD_ID,
                    '42',
                    'media',
                    'lua',
                    'main.lua',
                ),
            ),
            'Mod media file was not packaged',
        );
    });
});
