import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runCLI, setProjectDir, createPzStudio } from '@pzstudio/cli/api';
import type { PzStudioLogger } from '@pzstudio/cli/api';
import { readPzStudioHostSettings } from '../util/settings';

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
        // Redirect the api's homedir() INSIDE the extension host only —
        // overriding HOME in the spawned VS Code process (test-electron
        // passes env to the whole app) breaks Electron's own state
        // locations on macOS. os.homedir() reads the env on every call,
        // so the api bridge sees the fake home from here on.
        assert.ok(fakeHome, 'fixture fake home env is missing');
        process.env.HOME = fakeHome;
        process.env.USERPROFILE = fakeHome;
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
        await runCLI('build', [], { flags: [] });

        const workshopTxt = path.join(
            projectDir,
            'dist',
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
                    projectDir,
                    'dist',
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

    it('renames and deletes a mod through the api with explicit --yes (embedded)', async () => {
        assert.ok(projectDir, 'fixture project dir env is missing');

        setProjectDir(projectDir);
        const configPath = path.join(projectDir, 'project.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.mods.scratch_mod = { name: 'Scratch', description: 'tmp' };
        fs.mkdirSync(path.join(projectDir, 'scratch_mod'), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(projectDir, 'scratch_mod', 'marker.txt'),
            'owned by scratch_mod',
        );
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));

        await runCLI('rename', ['scratch_mod', 'renamed_scratch'], {
            flags: ['--yes'],
        });
        assert.strictEqual(
            fs.readFileSync(
                path.join(projectDir, 'renamed_scratch', 'marker.txt'),
                'utf8',
            ),
            'owned by renamed_scratch',
        );
        const renamed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.ok(renamed.mods.renamed_scratch);
        assert.strictEqual(renamed.mods.scratch_mod, undefined);

        await runCLI('delete', ['renamed_scratch'], { flags: ['--yes'] });
        assert.ok(!fs.existsSync(path.join(projectDir, 'renamed_scratch')));
        const deleted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.strictEqual(deleted.mods.renamed_scratch, undefined);
    });

    it('isolates a second test-owned PzStudio instance from the migrated runner path under overlapping execution', async function () {
        this.timeout(120000);
        assert.ok(fakeHome, 'fixture fake home env is missing');

        const config = vscode.workspace.getConfiguration('pzstudio');
        await config.update(
            'confirmBeforeRun',
            false,
            vscode.ConfigurationTarget.Global,
        );

        const secondProject = path.join(fakeHome, 'iso-second-project');
        fs.mkdirSync(secondProject, { recursive: true });
        fs.writeFileSync(
            path.join(secondProject, 'project.json'),
            JSON.stringify({
                workshop: {
                    title: 'Iso Second Project',
                    visibility: 'public',
                    tags: [],
                },
                mods: {},
                excludes: [],
            }),
        );
        const secondCalls: string[] = [];
        const secondLogger: PzStudioLogger = {
            log: (m) => secondCalls.push(String(m)),
            info: (m) => secondCalls.push(String(m)),
            warn: (m) => secondCalls.push(String(m)),
            error: (e) => secondCalls.push(String(e)),
        };
        const secondStudio = createPzStudio({
            projectDir: secondProject,
            logger: secondLogger,
        });

        const fixtureOut = path.join(projectDir, 'dist', PROJECT_TITLE);
        fs.rmSync(fixtureOut, { recursive: true, force: true });

        try {
            const runnerBuild =
                vscode.commands.executeCommand('pzstudio.build');
            const secondRun = secondStudio.run('list');
            await Promise.all([runnerBuild, secondRun]);
        } finally {
            await config.update(
                'confirmBeforeRun',
                true,
                vscode.ConfigurationTarget.Global,
            );
        }

        assert.ok(
            secondCalls.some((line) =>
                line.includes("No mods in project 'Iso Second Project'."),
            ),
            `second instance did not resolve its own project: ${secondCalls.join('\n')}`,
        );
        assert.ok(
            !secondCalls.some((line) => line.includes(PROJECT_TITLE)),
            'the runner project leaked into the second instance logger',
        );

        assert.ok(
            fs.existsSync(path.join(fixtureOut, 'workshop.txt')),
            `runner build output missing: ${path.join(fixtureOut, 'workshop.txt')}`,
        );
        assert.ok(
            !fs.existsSync(
                path.join(secondProject, 'dist', 'Iso Second Project'),
            ),
            'the second instance created its own dist output',
        );
    });

    it('resolves resource-scoped settings per workspace folder (UX-05)', async function () {
        this.timeout(60000);
        const secondDir = process.env.PZSTUDIO_TEST_SECOND_DIR ?? '';
        const outdirB = process.env.PZSTUDIO_TEST_OUTDIR_B ?? '';
        assert.ok(projectDir, 'fixture project dir env is missing');
        assert.ok(secondDir && outdirB, 'multi-root fixture env is missing');

        const innerProjectB = path.join(secondDir, 'sub', 'inner');

        const inspectA = vscode.workspace
            .getConfiguration('pzstudio', vscode.Uri.file(projectDir))
            .inspect<boolean>('useSymlinks');
        assert.strictEqual(inspectA?.workspaceFolderValue, false);
        assert.strictEqual(inspectA?.workspaceValue, true);
        const inspectB = vscode.workspace
            .getConfiguration('pzstudio', vscode.Uri.file(innerProjectB))
            .inspect<string>('outdir');
        assert.strictEqual(inspectB?.workspaceFolderValue, outdirB);

        const forA = readPzStudioHostSettings({ projectDir });
        assert.strictEqual(forA.workspace?.useSymlinks, false);
        assert.strictEqual(forA.workspace?.outdir, undefined); // A sets no outdir
        const forB = readPzStudioHostSettings({ projectDir: innerProjectB });
        assert.strictEqual(forB.workspace?.outdir, outdirB);
        assert.strictEqual(forB.workspace?.useSymlinks, true); // workspace fallback

        const resourceLess = readPzStudioHostSettings({});
        assert.strictEqual(resourceLess.workspace?.useSymlinks, true);
        assert.strictEqual(resourceLess.workspace?.outdir, undefined);

        const studio = createPzStudio({
            settings: readPzStudioHostSettings,
        });
        const report = await studio.runProjectDoctor(innerProjectB);
        const missing = report.diagnostics.filter(
            (d) => d.code === 'filesystem.outDirMissing',
        );
        assert.strictEqual(
            missing.length,
            1,
            `expected one outDirMissing finding, got: ${report.diagnostics
                .map((d) => d.code)
                .join(', ')}`,
        );
        assert.ok(
            missing[0].message.includes(path.resolve(outdirB)),
            `doctor did not consume folder B's outdir: ${missing[0].message}`,
        );
    });
});
