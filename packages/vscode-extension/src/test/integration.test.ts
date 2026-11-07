import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runCLI, setProjectDir, createPzStudio } from '@pzstudio/cli/api';
import type { PzStudioLogger } from '@pzstudio/cli/api';
import { readPzStudioHostSettings } from '../util/settings';

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

        // Embedded contract (CLI-9): runCLI NEVER terminal-prompts, and it
        // REQUIRES --yes for destructive commands — the host passes it once
        // its own confirmation UI has accepted.
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
        // The overlap runs a real build (template cache + engine lifecycle)
        // next to a second instance's run; give it more than the default.
        this.timeout(120000);
        assert.ok(fakeHome, 'fixture fake home env is missing');

        // The build command's modal confirmation would block the host: the
        // scenario runs pzstudio.build through the migrated runner, so the
        // setting is disabled for this test (and restored afterwards).
        const config = vscode.workspace.getConfiguration('pzstudio');
        await config.update(
            'confirmBeforeRun',
            false,
            vscode.ConfigurationTarget.Global,
        );

        // A second project the workspace does NOT contain (the fixture
        // project is the single workspace project, so the runner resolves
        // it without a picker) with its OWN recording logger.
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

        // Meaningful disk assertion: remove the fixture's earlier build
        // output so only THIS scenario's runner build can recreate it.
        const fixtureOut = path.join(
            fakeHome,
            'Zomboid',
            'Workshop',
            PROJECT_TITLE,
        );
        fs.rmSync(fixtureOut, { recursive: true, force: true });

        try {
            // Overlap: the extension command (runner → the host-owned
            // instance → engine) and the second instance's run are both in
            // flight in this extension-host process. The engine lock is
            // process-wide FIFO within the inlined api module (pinned by
            // the vitest suites); this scenario proves what the unit tests
            // cannot: the real runner path and an independently created
            // instance keep their sinks and project identities apart in the
            // real host.
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

        // The second instance's sink: its own project only — never the
        // fixture project the runner built.
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

        // The runner's sink (project identity on disk): the extension build
        // landed under the fixture project in the default outdir, and the
        // second project contributed nothing there.
        assert.ok(
            fs.existsSync(path.join(fixtureOut, 'workshop.txt')),
            `runner build output missing: ${path.join(fixtureOut, 'workshop.txt')}`,
        );
        assert.ok(
            !fs.existsSync(
                path.join(
                    fakeHome,
                    'Zomboid',
                    'Workshop',
                    'Iso Second Project',
                ),
            ),
            'the second instance wrote into the runner outdir',
        );
    });

    // UX-05: resource-scoped settings must follow the operated project's
    // folder. The multi-root fixture gives folder A (the fixture project)
    // one folder-scoped setting and folder B (a plain folder with a
    // depth-2 project) its own outdir; the workspace file sets a
    // workspace-level value the folder tier must beat.
    it('resolves resource-scoped settings per workspace folder (UX-05)', async function () {
        this.timeout(60000);
        const secondDir = process.env.PZSTUDIO_TEST_SECOND_DIR ?? '';
        const outdirB = process.env.PZSTUDIO_TEST_OUTDIR_B ?? '';
        assert.ok(projectDir, 'fixture project dir env is missing');
        assert.ok(secondDir && outdirB, 'multi-root fixture env is missing');

        // A depth-2 project under folder B: outside project discovery
        // (root + depth-1) but its resource still belongs to folder B.
        const innerProjectB = path.join(secondDir, 'sub', 'inner');

        // Real host configuration semantics first: the folder tier exists
        // per folder, distinct from the workspace tier.
        const inspectA = vscode.workspace
            .getConfiguration('pzstudio', vscode.Uri.file(projectDir))
            .inspect<boolean>('useSymlinks');
        assert.strictEqual(inspectA?.workspaceFolderValue, false);
        assert.strictEqual(inspectA?.workspaceValue, true);
        const inspectB = vscode.workspace
            .getConfiguration('pzstudio', vscode.Uri.file(innerProjectB))
            .inspect<string>('outdir');
        assert.strictEqual(inspectB?.workspaceFolderValue, outdirB);

        // The extension adapter composes the layers per project resource.
        const forA = readPzStudioHostSettings({ projectDir });
        assert.strictEqual(forA.workspace?.useSymlinks, false); // folder beats workspace
        assert.strictEqual(forA.workspace?.outdir, undefined); // A sets no outdir
        const forB = readPzStudioHostSettings({ projectDir: innerProjectB });
        assert.strictEqual(forB.workspace?.outdir, outdirB); // owning (nested) folder
        assert.strictEqual(forB.workspace?.useSymlinks, true); // workspace fallback

        // A resource-less (project-less global) resolution borrows no
        // folder value.
        const resourceLess = readPzStudioHostSettings({});
        assert.strictEqual(resourceLess.workspace?.useSymlinks, true);
        assert.strictEqual(resourceLess.workspace?.outdir, undefined);

        // End to end through the real engine: a doctor run for the
        // depth-2 project consumes folder B's outdir — the outDirMissing
        // finding names it.
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
