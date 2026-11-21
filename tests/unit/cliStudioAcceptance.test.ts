import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import type { TemplateTransport } from '@pzstudio/platform';

import { runCLI } from '../../packages/cli/src/lib/cli';
import { createPzStudio } from '../../packages/cli/src/lib/studio';
import { createDevSync } from '../../packages/cli/src/lib/devsync';
import { runProjectDoctor } from '../../packages/cli/src/lib/doctor';
import { setLogger } from '../../packages/cli/src/lib/logger';
import { setCliIO, type CliIO } from '../../packages/cli/src/lib/parser';
import { CliUsageError } from '../../packages/cli/src/lib/parser';
import {
    setProjectDir,
    getExternalProjectDir,
    setProjectRootAnchor,
    legacyDiscoveryStart,
    discoveryStartDir,
    setVsCodeSettings,
    getVsCodeSettings,
    legacySettings,
} from '../../packages/cli/src/lib/helper';
import { setTemplateTransport } from '../../packages/cli/src/lib/transport';
import { setInvocationOptions } from '../../packages/cli/src/lib/args';
import { setInteractionMode } from '../../packages/cli/src/lib/interaction';
import { getCommand } from '../../packages/cli/src/lib/registry';
import { getActiveInvocationContext } from '../../packages/cli/src/lib/invocation';
import * as helperModule from '../../packages/cli/src/lib/helper';

interface LogCall {
    method: string;
    message: any;
}

function recordingLogger() {
    const calls: LogCall[] = [];
    const logger = {
        log: (m: any) => calls.push({ method: 'log', message: m }),
        info: (m: any) => calls.push({ method: 'info', message: m }),
        warn: (m: any) => calls.push({ method: 'warn', message: m }),
        error: (e: any) => calls.push({ method: 'error', message: e }),
        verbose: (m: any) => calls.push({ method: 'verbose', message: m }),
    };
    return { calls, logger };
}

function loggerText(rec: { calls: LogCall[] }): string {
    return rec.calls.map((c) => String(c.message)).join('\n');
}

function captureIO(): { stdout: string[]; stderr: string[] } {
    const captured = { stdout: [] as string[], stderr: [] as string[] };
    const sink: CliIO = {
        stdout: (t) => captured.stdout.push(t),
        stderr: (t) => captured.stderr.push(t),
    };
    setCliIO(sink);
    return captured;
}

let tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = createTempDir();
    tempDirs.push(dir);
    return dir;
}

function makeProjectDir(title: string): string {
    const dir = makeTempDir();
    fs.writeFileSync(
        path.join(dir, 'project.json'),
        JSON.stringify({
            workshop: { title, visibility: 'public', tags: [] },
            mods: {},
            excludes: [],
        }),
    );
    return dir;
}

function makeModProject(title: string, modId: string): string {
    const dir = makeProjectDir(title);
    const config = JSON.parse(
        fs.readFileSync(path.join(dir, 'project.json'), 'utf8'),
    );
    config.mods[modId] = { name: modId, description: 'test mod' };
    config.outdir = 'out';
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(config));
    fs.mkdirSync(path.join(dir, modId, 'media', 'lua'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, modId, 'media', 'lua', 'main.lua'),
        'print("v1")',
    );
    return dir;
}

function sentinelTransport(name: 'git' | 'fetch' = 'git'): TemplateTransport {
    return {
        name,
        download: () => {},
        refresh: () => false,
        isCacheValid: () => false,
    };
}

function withCommandRun(
    name: string,
    swapped: () => Promise<void>,
): () => void {
    const def = getCommand(name)!;
    const original = def.run;
    def.run = swapped;
    return () => {
        def.run = original;
    };
}

const helperNs = helperModule as unknown as Record<string, any>;

afterEach(() => {
    vi.restoreAllMocks();
    setLogger(undefined);
    setCliIO(undefined);
    setProjectDir(undefined);
    setProjectRootAnchor(undefined);
    setTemplateTransport(undefined);
    setInvocationOptions(undefined);
    setVsCodeSettings(undefined, undefined);
    setInteractionMode('embedded');
    for (const dir of tempDirs) deleteDir(dir);
    tempDirs = [];
});

describe('v2 destructive consent (embedded contract unchanged)', () => {
    it('delete without --yes refuses with the embedded usage error; with --yes it proceeds', async () => {
        captureIO();
        const proj = makeModProject('Consent Project', 'scratch_mod');
        const studio = createPzStudio({ projectDir: proj });

        await expect(
            studio.run('delete', ['scratch_mod']),
        ).rejects.toBeInstanceOf(CliUsageError);
        expect(fs.existsSync(path.join(proj, 'scratch_mod'))).toBe(true);

        await studio.run('delete', ['scratch_mod'], { flags: ['--yes'] });

        expect(fs.existsSync(path.join(proj, 'scratch_mod'))).toBe(false);
        const config = JSON.parse(
            fs.readFileSync(path.join(proj, 'project.json'), 'utf8'),
        );
        expect(config.mods.scratch_mod).toBeUndefined();
    });

    it('rename without --yes refuses; with --yes it proceeds', async () => {
        captureIO();
        const proj = makeModProject('Consent Rename', 'scratch_mod');
        const studio = createPzStudio({ projectDir: proj });

        await expect(
            studio.run('rename', ['scratch_mod', 'renamed_mod']),
        ).rejects.toBeInstanceOf(CliUsageError);
        expect(fs.existsSync(path.join(proj, 'scratch_mod'))).toBe(true);

        await studio.run('rename', ['scratch_mod', 'renamed_mod'], {
            flags: ['--yes'],
        });

        expect(fs.existsSync(path.join(proj, 'scratch_mod'))).toBe(false);
        expect(fs.existsSync(path.join(proj, 'renamed_mod'))).toBe(true);
    });
});

describe('add refuses the no-op --yes flag (d14-F1)', () => {
    it('v2 door: add with --yes is a usage error (exit 2 class), never a silent no-op', async () => {
        captureIO();
        const studio = createPzStudio();

        await expect(
            studio.run('add', ['Yes Mod', 'yes_mod'], { flags: ['--yes'] }),
        ).rejects.toBeInstanceOf(CliUsageError);
        await expect(
            studio.run('add', ['Yes Mod', 'yes_mod'], { flags: ['--yes'] }),
        ).rejects.toThrow(/--yes flag is not applicable to command \[add\]/);
    });
});

describe('v2 lifecycle hygiene: no process.exit, no argv mutation', () => {
    it('success, help, usage-error and throwing-command paths never exit and never touch process.argv', async () => {
        const captured = captureIO();
        const proj = makeProjectDir('Hygiene Project');
        const emptyDir = makeTempDir();
        const studio = createPzStudio();

        const exitSpy = vi
            .spyOn(process, 'exit')
            .mockImplementation((() => undefined) as never);
        const argvBefore = [...process.argv];

        try {
            await studio.run('list', [], { flags: ['--project', proj] });
            await studio.run('help');
            await expect(
                studio.run('build', [], { flags: ['--wat'] }),
            ).rejects.toBeInstanceOf(CliUsageError);
            await expect(
                studio.run('list', [], { flags: ['--project', emptyDir] }),
            ).rejects.toThrow();

            expect(exitSpy).not.toHaveBeenCalled();
            expect(process.argv).toEqual(argvBefore);
        } finally {
            exitSpy.mockRestore();
        }
        expect(captured.stderr.join('')).toContain('Command [list] completed.');
    });
});

describe('two instances: a v2 DevSync apply overlaps a parked v2 command run', () => {
    it("the sync runs lock-free beside the command, lands in ITS OWN outdir and logger, and never touches the command instance's", async () => {
        captureIO();
        const makeSyncSide = (title: string, modId: string) => {
            const dir = makeProjectDir(title);
            const config = JSON.parse(
                fs.readFileSync(path.join(dir, 'project.json'), 'utf8'),
            );
            config.mods[modId] = { name: modId, description: 'test mod' };
            fs.writeFileSync(
                path.join(dir, 'project.json'),
                JSON.stringify(config),
            );
            fs.mkdirSync(path.join(dir, modId, 'media', 'lua'), {
                recursive: true,
            });
            fs.writeFileSync(
                path.join(dir, modId, 'media', 'lua', 'main.lua'),
                'print("v1")',
            );
            return dir;
        };
        const projA = makeSyncSide('CmdSide', 'my_mod');
        const projB = makeSyncSide('SyncSide', 'my_mod');
        const outA = makeTempDir();
        const outB = makeTempDir();
        const loggerA = recordingLogger();
        const loggerB = recordingLogger();

        const studioA = createPzStudio({
            projectDir: projA,
            logger: loggerA.logger,
            settings: () => ({ workspace: { outdir: outA } }),
            templateTransport: sentinelTransport('git'),
        });
        const studioB = createPzStudio({
            projectDir: projB,
            logger: loggerB.logger,
            settings: () => ({ workspace: { outdir: outB } }),
            templateTransport: sentinelTransport('fetch'),
        });

        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        let parked = Promise.resolve() as Promise<void>;
        let restore: () => void = () => {};
        try {
            parked = studioA.run('list', [], { flags: ['--project', projA] });
            restore = withCommandRun('list', async () => {
                await gate;
            });
            await vi.waitFor(() =>
                expect(getActiveInvocationContext()).toBeDefined(),
            );

            const templateDir = path.join(makeTempDir(), 'tpl-workshop');
            fs.mkdirSync(templateDir, { recursive: true });
            const session = studioB.createDevSync(projB, {
                workshopTemplateDir: templateDir,
            });
            try {
                await session.start(['main']);
            } finally {
                await session.stop();
            }

            expect(fs.existsSync(path.join(projB, 'dist', 'SyncSide'))).toBe(
                true,
            );
            expect(fs.readdirSync(outB)).toEqual([]);
            expect(fs.readdirSync(outA)).toEqual([]);

            expect(loggerText(loggerB)).toContain('SyncSide');
            expect(loggerB.calls.length).toBeGreaterThan(0);
            expect(loggerText(loggerA)).not.toContain('SyncSide');
        } finally {
            release();
            restore();
            await parked.catch(() => {});
        }
        expect(getActiveInvocationContext()).toBeUndefined();
    });
});

describe('v2 doctor: no anchor touch, golden equality with the legacy door', () => {
    it('never reads or writes the global anchor and leaves discovery untouched', async () => {
        captureIO();
        const proj = makeProjectDir('Doctor V2');
        const anchored = makeTempDir();
        setProjectDir(anchored);
        setVsCodeSettings({ outdir: 'C:/legacy-doctor-out' });

        const externalDirSpy = vi.spyOn(helperNs, 'getExternalProjectDir');
        const studio = createPzStudio({ logger: recordingLogger().logger });

        await studio.runProjectDoctor(proj, { gameBuild: '42.20.1' });

        expect(externalDirSpy).not.toHaveBeenCalled();
        expect(getExternalProjectDir()).toBe(anchored);
        expect(legacyDiscoveryStart()).toBe(anchored);
        expect(getVsCodeSettings()).toEqual({
            templates: undefined,
            outdir: 'C:/legacy-doctor-out',
            useSymlinks: undefined,
        });
    });

    it('the v2 report equals the legacy call report on the same fixture', async () => {
        captureIO();
        const proj = makeProjectDir('Doctor Golden V2');
        const layers = { workspace: { outdir: 'C:/golden-doctor-out' } };
        setVsCodeSettings(layers.workspace);

        const legacy = await runProjectDoctor(proj, { gameBuild: '42.20.1' });

        const studio = createPzStudio({
            logger: recordingLogger().logger,
            settings: () => layers,
        });
        const v2 = await studio.runProjectDoctor(proj, {
            gameBuild: '42.20.1',
        });

        expect(v2).toEqual(legacy);
        expect(v2.projectDir).toBe(proj);
        expect(v2.diagnostics.length).toBeGreaterThan(0);
    });

    it('the legacy doctor still save/restores the anchor beside a populated slot (facade parity)', async () => {
        captureIO();
        const proj = makeProjectDir('Doctor Legacy Restore');
        const previous = makeTempDir();
        setProjectDir(previous);

        await runProjectDoctor(proj, { gameBuild: '42.20.1' });

        expect(getExternalProjectDir()).toBe(previous);
        expect(legacyDiscoveryStart()).toBe(previous);
    });
});

describe('legacy write-through remains observable end-to-end', () => {
    it('a legacy --project run persists the anchor; a subsequent v2 DevSync on the LEGACY door discovers from it; a v2 run never does', async () => {
        captureIO();
        const legacyAnchor = makeModProject('Anchor Legacy', 'my_mod');
        const v2Proj = makeModProject('Anchor V2', 'my_mod');
        const legacyTemplate = path.join(makeTempDir(), 'tpl-workshop');
        fs.mkdirSync(legacyTemplate, { recursive: true });

        await runCLI('help', [], { flags: ['--project', legacyAnchor] });
        expect(legacyDiscoveryStart()).toBe(path.resolve(legacyAnchor));

        const legacySession = createDevSync(legacyAnchor, {
            workshopTemplateDir: legacyTemplate,
        });
        try {
            await legacySession.start(['main']);
        } finally {
            await legacySession.stop();
        }
        expect(getExternalProjectDir()).toBe(legacyAnchor);

        const studio = createPzStudio({ projectDir: v2Proj });
        let sawStart: string | undefined;
        const restore = withCommandRun('list', async () => {
            sawStart = discoveryStartDir();
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }
        expect(sawStart).toBe(v2Proj);
        expect(getExternalProjectDir()).toBe(legacyAnchor);
    });

    it('the legacy settings accessor reflects the slots the facade contract feeds (spy validity pin)', () => {
        setVsCodeSettings({ outdir: 'C:/ws-layer' }, { useSymlinks: true });
        expect(legacySettings()).toEqual({
            workspace: { outdir: 'C:/ws-layer' },
            user: { useSymlinks: true },
        });
    });
});
