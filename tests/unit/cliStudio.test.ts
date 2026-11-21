import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import type { TemplateTransport } from '@pzstudio/platform';

const spawnSyncCalls = vi.hoisted(
    () => [] as Array<{ command: string; args?: readonly string[] }>,
);

vi.mock('child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('child_process')>();
    return {
        ...original,
        spawnSync: (command: string, args?: readonly string[], opts?: any) => {
            spawnSyncCalls.push({ command, args });
            return original.spawnSync(command, args as any, opts);
        },
    };
});

import { runCLI } from '../../packages/cli/src/lib/cli';
import { createPzStudio } from '../../packages/cli/src/lib/studio';
import {
    setLogger,
    setVerbose,
    setQuiet,
    setDebug,
    rawLog,
    rawInfo,
    rawVerbose,
    error as engineError,
} from '../../packages/cli/src/lib/logger';
import {
    CliUsageError,
    setCliIO,
    type CliIO,
} from '../../packages/cli/src/lib/parser';
import { CliError } from '../../packages/cli/src/lib/errors';
import { hasFlag, setInvocationOptions } from '../../packages/cli/src/lib/args';
import {
    setProjectDir,
    setProjectRootAnchor,
    legacyDiscoveryStart,
    getExternalProjectDir,
    setVsCodeSettings,
    getVsCodeSettings,
    discoveryStartDir,
} from '../../packages/cli/src/lib/helper';
import {
    setTemplateTransport,
    legacyTransport,
    getTemplateTransport,
    FetchTransport,
    GitTransport,
} from '../../packages/cli/src/lib/transport';
import {
    setInteractionMode,
    getInteractionMode,
} from '../../packages/cli/src/lib/interaction';
import { getCommand } from '../../packages/cli/src/lib/registry';
import { getActiveInvocationContext } from '../../packages/cli/src/lib/invocation';
import {
    getConfigDir,
    getConfigPath,
} from '../../packages/cli/src/lib/templateManager';
import * as helperModule from '../../packages/cli/src/lib/helper';
import * as loggerModule from '../../packages/cli/src/lib/logger';
import * as transportModule from '../../packages/cli/src/lib/transport';

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

interface Captured {
    stdout: string[];
    stderr: string[];
}

function captureIO(): Captured {
    const captured: Captured = { stdout: [], stderr: [] };
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

function preseedNoticeMarker(): void {
    const dir = path.join(getConfigDir(), 'usage');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.notice-shown'), '', 'utf-8');
}

const helperNs = helperModule as unknown as Record<string, any>;
const loggerNs = loggerModule as unknown as Record<string, any>;
const transportNs = transportModule as unknown as Record<string, any>;

function spyRawAccessors() {
    return {
        externalDir: vi.spyOn(helperNs, 'getExternalProjectDir'),
        legacySettings: vi.spyOn(helperNs, 'legacySettings'),
        legacyDiscoveryStart: vi.spyOn(helperNs, 'legacyDiscoveryStart'),
        legacyLogger: vi.spyOn(loggerNs, 'legacyLogger'),
        legacyTransport: vi.spyOn(transportNs, 'legacyTransport'),
    };
}

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
    setVerbose(false);
    setQuiet(false);
    setDebug(false);
    spawnSyncCalls.length = 0;
    for (const dir of tempDirs) deleteDir(dir);
    tempDirs = [];
});

describe('golden equivalence: runCLI ≡ studio.run (captured output)', () => {
    it('normal success: identical stdout/stderr sequences', async () => {
        const proj = makeProjectDir('Golden');
        const studio = createPzStudio();

        preseedNoticeMarker();

        const legacy = captureIO();
        await runCLI('list', [], { flags: ['--project', proj] });
        const legacyOut = {
            stdout: [...legacy.stdout],
            stderr: [...legacy.stderr],
        };

        setCliIO(undefined);
        const v2 = captureIO();
        await studio.run('list', [], { flags: ['--project', proj] });

        expect(v2.stdout).toEqual(legacyOut.stdout);
        expect(v2.stderr).toEqual(legacyOut.stderr);
        expect(legacyOut.stdout).toEqual([
            '\n',
            "No mods in project 'Golden'.\n",
            '\n',
        ]);
        expect(legacyOut.stderr).toEqual([
            '[INFO] Command [list] completed.\n',
        ]);
    });

    it('help: identical stdout/stderr sequences', async () => {
        const studio = createPzStudio();

        const legacy = captureIO();
        await runCLI('help');
        const legacyOut = [...legacy.stdout];

        setCliIO(undefined);
        const v2 = captureIO();
        await studio.run('help');

        expect(v2.stdout).toEqual(legacyOut);
        expect(legacyOut[0]).toContain('Available commands:');
        expect(legacyOut[1]).toBe('\n');
    });

    it('usage error: identical error report and same rejection kind', async () => {
        const studio = createPzStudio();

        const legacy = captureIO();
        await expect(
            runCLI('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError);
        const legacyErr = [...legacy.stderr];

        setCliIO(undefined);
        const v2 = captureIO();
        await expect(
            studio.run('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError);

        expect(v2.stderr).toEqual(legacyErr);
        expect(legacyErr.join('')).toContain("Unknown option '--wat'");
    });

    it('invalid enum flag value (d11-F8): the handler path rejects with parse-stage usage semantics on both doors', async () => {
        const proj = makeProjectDir('EnumFlag');
        const studio = createPzStudio();

        preseedNoticeMarker();

        const legacy = captureIO();
        await expect(
            runCLI('build', [], {
                flags: ['--project', proj, '--materialize=bogus'],
            }),
        ).rejects.toBeInstanceOf(CliUsageError);
        const legacyErr = [...legacy.stderr];

        setCliIO(undefined);
        const v2 = captureIO();
        await expect(
            studio.run('build', [], {
                flags: ['--project', proj, '--materialize=bogus'],
            }),
        ).rejects.toBeInstanceOf(CliUsageError);

        expect(v2.stderr).toEqual(legacyErr);
        expect(legacyErr.join('')).toContain(
            "Invalid --materialize value 'bogus' (expected one of: symlink, copy)",
        );
    });

    it('throwing command: identical error report and same rejection kind', async () => {
        const emptyDir = makeTempDir();
        const studio = createPzStudio();

        preseedNoticeMarker();

        const legacy = captureIO();
        await expect(
            runCLI('list', [], { flags: ['--project', emptyDir] }),
        ).rejects.toBeInstanceOf(CliError);
        const legacyOut = [...legacy.stdout];
        const legacyErr = [...legacy.stderr];

        setCliIO(undefined);
        const v2 = captureIO();
        await expect(
            studio.run('list', [], { flags: ['--project', emptyDir] }),
        ).rejects.toBeInstanceOf(CliError);

        expect(v2.stdout).toEqual(legacyOut);
        expect(v2.stderr).toEqual(legacyErr);
        expect(legacyOut).toEqual(['\n']);
        expect(legacyErr.join('')).toContain('No pzstudio project found.');
    });
});

describe('R0 legacy-blindness (v2 never falls through to the facade)', () => {
    it('with every legacy setter populated, a v2 instance with all fields omitted consumes none of them', async () => {
        const projA = makeProjectDir('ProjA');
        const L1 = recordingLogger();
        const T1 = sentinelTransport('fetch');

        setProjectDir(projA);
        setLogger(L1.logger);
        setVsCodeSettings({ outdir: 'C:/legacy-ws-out' });
        setTemplateTransport(T1);

        const spies = spyRawAccessors();
        const captured = captureIO();

        await runCLI('help');
        expect(spies.legacyLogger).toHaveBeenCalled();
        expect(spies.legacyTransport).toHaveBeenCalled();
        expect(spies.externalDir).toHaveBeenCalled();
        expect(spies.legacySettings).toHaveBeenCalled();
        for (const spy of Object.values(spies)) spy.mockClear();
        L1.calls.length = 0;

        const studio = createPzStudio();

        let during:
            | {
                  settings: ReturnType<typeof getVsCodeSettings>;
                  transport: unknown;
                  start: string;
              }
            | undefined;
        const restore = withCommandRun('list', async () => {
            during = {
                settings: getVsCodeSettings(),
                transport: getTemplateTransport(),
                start: discoveryStartDir(),
            };
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(during!.settings).toEqual({
            templates: undefined,
            outdir: undefined,
            useSymlinks: undefined,
        });
        expect(during!.transport).not.toBe(T1);
        expect(during!.start).toBe(process.cwd());
        expect(during!.start).not.toBe(projA);

        const err = await studio.run('list').catch((e) => e);
        expect(err).toBeInstanceOf(CliError);
        expect(String(err.cause)).toContain(process.cwd());
        expect(String(err.cause)).not.toContain(projA);

        expect(L1.calls).toEqual([]);
        expect(captured.stderr.join('')).toContain('[ERROR]');

        expect(spies.legacyLogger).not.toHaveBeenCalled();
        expect(spies.legacySettings).not.toHaveBeenCalled();
        expect(spies.legacyTransport).not.toHaveBeenCalled();
        expect(spies.externalDir).not.toHaveBeenCalled();
        expect(spies.legacyDiscoveryStart).not.toHaveBeenCalled();
    });

    it('mirror: a fully-populated instance also never reads the legacy slots', async () => {
        const projB = makeProjectDir('ProjB');
        const L1 = recordingLogger();
        const L2 = recordingLogger();
        const T1 = sentinelTransport('fetch');
        const T2 = sentinelTransport('git');
        const provider = vi.fn(() => ({ user: { outdir: 'C:/v2-out' } }));

        setProjectDir(projB);
        setLogger(L1.logger);
        setVsCodeSettings({ outdir: 'C:/legacy-ws-out' });
        setTemplateTransport(T1);

        const spies = spyRawAccessors();
        captureIO();

        const studio = createPzStudio({
            projectDir: projB,
            logger: L2.logger,
            settings: provider,
            templateTransport: T2,
        });

        const restore = withCommandRun('list', async () => {});
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(L1.calls).toEqual([]);
        expect(L2.calls.map((c) => c.method)).toEqual([
            'log',
            'info',
            'info',
            'log',
        ]);
        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledWith({ projectDir: projB });
        expect(spies.legacyLogger).not.toHaveBeenCalled();
        expect(spies.legacySettings).not.toHaveBeenCalled();
        expect(spies.legacyTransport).not.toHaveBeenCalled();
        expect(spies.externalDir).not.toHaveBeenCalled();
        expect(spies.legacyDiscoveryStart).not.toHaveBeenCalled();
    });
});

describe('v2 writes nothing to the legacy slots (§13.1 mirror)', () => {
    it('after an aggressive v2 run, the persisted legacy fields keep their pre-run values', async () => {
        const captured = captureIO();
        const projAnchor = makeTempDir();
        const projExternal = makeTempDir();
        const projFlag = makeTempDir();
        const T1 = sentinelTransport('git');

        setProjectRootAnchor(projAnchor);
        setProjectDir(projExternal);
        setVsCodeSettings({ outdir: 'C:/legacy-ws-out' });
        setTemplateTransport(T1);
        setInteractionMode('non-interactive');
        setInvocationOptions({ marker: 'keep' });
        setVerbose(true);
        setQuiet(false);
        setDebug(true);

        const studio = createPzStudio();
        await studio.run('help', [], {
            flags: [
                '--project',
                projFlag,
                '--verbose',
                '--quiet',
                '--debug',
                '--transport',
                'fetch',
            ],
        });

        expect(legacyDiscoveryStart()).toBe(projAnchor);
        expect(getExternalProjectDir()).toBe(projExternal);
        expect(legacyTransport()).toBe(T1);
        expect(getTemplateTransport()).toBe(T1);
        expect(getInteractionMode()).toBe('non-interactive');
        expect(hasFlag('marker')).toBe(true);
        expect(hasFlag('verbose')).toBe(false);
        expect(hasFlag('project')).toBe(false);
        expect(hasFlag('transport')).toBe(false);
        rawVerbose('post-v2-verbose');
        expect(captured.stderr.join('')).toContain('[DEBUG] post-v2-verbose');
        rawInfo('post-v2-info');
        expect(captured.stderr.join('')).toContain('[INFO] post-v2-info');
        engineError(new Error('boom'));
        expect(captured.stderr.join('')).toContain('Unexpected error: boom');
        expect(captured.stderr.join('')).not.toContain('Run with --debug');
        expect(getVsCodeSettings()).toEqual({
            templates: undefined,
            outdir: 'C:/legacy-ws-out',
            useSymlinks: undefined,
        });
    });

    it('the logger slot is neither consumed nor cleared: published calls still route to it, and it receives nothing from the v2 run', async () => {
        const captured = captureIO();
        const projAnchor = makeTempDir();
        const projExternal = makeTempDir();
        const projFlag = makeTempDir();
        const L1 = recordingLogger();
        const T1 = sentinelTransport('git');

        setProjectRootAnchor(projAnchor);
        setProjectDir(projExternal);
        setLogger(L1.logger);
        setVsCodeSettings({ outdir: 'C:/legacy-ws-out' });
        setTemplateTransport(T1);

        const studio = createPzStudio();
        await studio.run('help', [], {
            flags: ['--project', projFlag, '--verbose', '--transport', 'fetch'],
        });

        expect(L1.calls).toEqual([]);
        expect(captured.stdout.join('')).toContain('Available commands:');

        rawLog('still-legacy');
        expect(L1.calls).toEqual([{ method: 'log', message: 'still-legacy' }]);

        rawVerbose('still-gated');
        expect(L1.calls).toEqual([{ method: 'log', message: 'still-legacy' }]);
        expect(captured.stderr.join('')).not.toContain('still-gated');

        expect(legacyDiscoveryStart()).toBe(projAnchor);
        expect(getExternalProjectDir()).toBe(projExternal);
        expect(legacyTransport()).toBe(T1);
        expect(getVsCodeSettings()).toEqual({
            templates: undefined,
            outdir: 'C:/legacy-ws-out',
            useSymlinks: undefined,
        });
    });

    it('a v2 run without --project does not clear the legacy anchor either', async () => {
        captureIO();
        const projAnchor = makeTempDir();
        setProjectRootAnchor(projAnchor);

        const studio = createPzStudio();
        await studio.run('help');

        expect(legacyDiscoveryStart()).toBe(projAnchor);
    });
});

describe('v2 settings provider', () => {
    it('is called exactly once per operation — success, help and usage-error runs alike', async () => {
        captureIO();
        const proj = makeProjectDir('ProjSettings');
        const provider = vi.fn(() => ({ user: { outdir: 'C:/p-out' } }));
        const studio = createPzStudio({ projectDir: proj, settings: provider });

        await studio.run('list');
        expect(provider).toHaveBeenCalledTimes(1);

        await studio.run('help');
        expect(provider).toHaveBeenCalledTimes(2);

        await expect(
            studio.run('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError);
        expect(provider).toHaveBeenCalledTimes(3);
    });

    it('receives the parsed --project value — proof of post-parse resolution', async () => {
        captureIO();
        const projA = makeProjectDir('ProjA');
        const projC = makeProjectDir('ProjC');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({
            projectDir: projC,
            settings: provider,
        });

        await studio.run('list', [], { flags: ['--project', projA] });

        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledWith({
            projectDir: path.resolve(projA),
        });
    });

    it('a plain PzStudioHostSettings snapshot is accepted as a context-ignoring layer', async () => {
        captureIO();
        const proj = makeProjectDir('ProjObj');
        const studio = createPzStudio({
            projectDir: proj,
            settings: { workspace: { outdir: 'C:/obj-out' } },
        });

        let during: ReturnType<typeof getVsCodeSettings> | undefined;
        const restore = withCommandRun('list', async () => {
            during = getVsCodeSettings();
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(during).toEqual({
            templates: undefined,
            outdir: 'C:/obj-out',
            useSymlinks: undefined,
        });
    });

    it('no settings at all → the invocation has no host layer', async () => {
        captureIO();
        const proj = makeProjectDir('ProjNone');
        const studio = createPzStudio({ projectDir: proj });

        let during: ReturnType<typeof getVsCodeSettings> | undefined;
        const restore = withCommandRun('list', async () => {
            during = getVsCodeSettings();
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(during).toEqual({
            templates: undefined,
            outdir: undefined,
            useSymlinks: undefined,
        });
    });
});

describe('project precedence matrix (§11)', () => {
    it('--project A > per-call C > factory B: the run targets A and the provider receives A', async () => {
        const captured = captureIO();
        const projA = makeProjectDir('ProjA');
        const projC = makeProjectDir('ProjC');
        const projB = makeProjectDir('ProjB');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({
            projectDir: projB,
            settings: provider,
        });

        await studio.run('list', [], {
            flags: ['--project', projA],
            projectDir: projC,
        });

        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledWith({
            projectDir: path.resolve(projA),
        });
        expect(captured.stdout.join('')).toContain(
            "No mods in project 'ProjA'.",
        );
    });

    it('per-call C beats factory B', async () => {
        const captured = captureIO();
        const projC = makeProjectDir('ProjC');
        const projB = makeProjectDir('ProjB');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({
            projectDir: projB,
            settings: provider,
        });

        await studio.run('list', [], { projectDir: projC });

        expect(provider).toHaveBeenCalledWith({ projectDir: projC });
        expect(captured.stdout.join('')).toContain(
            "No mods in project 'ProjC'.",
        );
    });

    it('factory B alone is used as given', async () => {
        const captured = captureIO();
        const projB = makeProjectDir('ProjB');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({
            projectDir: projB,
            settings: provider,
        });

        await studio.run('list');

        expect(provider).toHaveBeenCalledWith({ projectDir: projB });
        expect(captured.stdout.join('')).toContain(
            "No mods in project 'ProjB'.",
        );
    });

    it('no layer at all: discovery from process.cwd() (and the provider is told so)', async () => {
        captureIO();
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({ settings: provider });

        const err = await studio.run('list').catch((e) => e);
        expect(err).toBeInstanceOf(CliError);
        expect(String(err.cause)).toContain(process.cwd());

        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider).toHaveBeenCalledWith({ projectDir: process.cwd() });
    });
});

describe('v2 transport model (§12)', () => {
    it('instance transport is used when supplied', async () => {
        captureIO();
        const proj = makeProjectDir('ProjT');
        const T2 = sentinelTransport('fetch');
        const studio = createPzStudio({
            projectDir: proj,
            templateTransport: T2,
        });

        let during: unknown;
        const restore = withCommandRun('list', async () => {
            during = getTemplateTransport();
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(during).toBe(T2);
    });

    it('host default used otherwise — never the sticky legacy slot, no probe on acquisition or non-template runs', async () => {
        captureIO();
        const proj = makeProjectDir('ProjT');
        const T1 = sentinelTransport('fetch');
        setTemplateTransport(T1);
        spawnSyncCalls.length = 0;

        const studio = createPzStudio({ projectDir: proj });

        let during: unknown;
        let restore = withCommandRun('list', async () => {
            during = getTemplateTransport();
        });
        try {
            await studio.run('list');
        } finally {
            restore();
        }

        expect(during).not.toBe(T1);
        expect(spawnSyncCalls).toEqual([]);

        restore = withCommandRun('help', async () => {});
        try {
            await studio.run('help');
            await expect(
                studio.run('build', [], { flags: ['--wat'] }),
            ).rejects.toBeInstanceOf(CliUsageError);
        } finally {
            restore();
        }
        expect(spawnSyncCalls).toEqual([]);
    });

    it('--transport overrides only that invocation; nothing sticky, legacy slot untouched', async () => {
        captureIO();
        const proj = makeProjectDir('ProjT');
        const T1 = sentinelTransport('git');
        const T2 = sentinelTransport('fetch');
        setTemplateTransport(T1);

        const studio = createPzStudio({
            projectDir: proj,
            templateTransport: T2,
        });

        const duringRuns: unknown[] = [];
        const restore = withCommandRun('list', async () => {
            duringRuns.push(getTemplateTransport());
        });
        try {
            await studio.run('list', [], {
                flags: ['--transport', 'fetch'],
            });
            await studio.run('list');
        } finally {
            restore();
        }

        expect(duringRuns[0]).toBeInstanceOf(FetchTransport);
        expect(duringRuns[1]).toBe(T2);
        expect(legacyTransport()).toBe(T1);
        expect(getTemplateTransport()).toBe(T1);
    });

    it('--transport git selects the git transport for the invocation', async () => {
        captureIO();
        const proj = makeProjectDir('ProjT');
        const studio = createPzStudio({ projectDir: proj });

        let during: unknown;
        const restore = withCommandRun('list', async () => {
            during = getTemplateTransport();
        });
        try {
            await studio.run('list', [], { flags: ['--transport', 'git'] });
        } finally {
            restore();
        }

        expect(during).toBeInstanceOf(GitTransport);
    });
});

describe('v2 lifecycle isolation', () => {
    it('context restored and lock released on success, help, usage error and throwing command', async () => {
        captureIO();
        const emptyDir = makeTempDir();
        const proj = makeProjectDir('ProjLifecycle');
        const studio = createPzStudio();

        await studio.run('list', [], { flags: ['--project', proj] });
        expect(getActiveInvocationContext()).toBeUndefined();

        await studio.run('help');
        expect(getActiveInvocationContext()).toBeUndefined();

        await expect(
            studio.run('build', [], { flags: ['--wat'] }),
        ).rejects.toBeInstanceOf(CliUsageError);
        expect(getActiveInvocationContext()).toBeUndefined();

        await expect(
            studio.run('list', [], { flags: ['--project', emptyDir] }),
        ).rejects.toBeInstanceOf(CliError);
        expect(getActiveInvocationContext()).toBeUndefined();

        await expect(studio.run('help')).resolves.toBeUndefined();
        expect(getActiveInvocationContext()).toBeUndefined();
    });

    it('every emission path routes through the instance logger', async () => {
        captureIO();
        const emptyDir = makeTempDir();
        const proj = makeProjectDir('ProjRouting');

        const success = recordingLogger();
        await createPzStudio({ logger: success.logger }).run('list', [], {
            flags: ['--project', proj],
        });
        expect(success.calls.map((c) => c.method)).toEqual([
            'log',
            'log',
            'info',
            'info',
            'log',
        ]);
        expect(String(success.calls[1].message)).toContain(
            "No mods in project 'ProjRouting'.",
        );

        const help = recordingLogger();
        await createPzStudio({ logger: help.logger }).run('help');
        expect(help.calls.map((c) => c.method)).toEqual(['log', 'log']);
        expect(String(help.calls[0].message)).toContain('Available commands:');

        const usage = recordingLogger();
        await expect(
            createPzStudio({ logger: usage.logger }).run('build', [], {
                flags: ['--wat'],
            }),
        ).rejects.toBeInstanceOf(CliUsageError);
        expect(usage.calls.map((c) => c.method)).toEqual(['error']);
        expect(usage.calls[0].message).toBeInstanceOf(CliUsageError);

        const thrown = recordingLogger();
        await expect(
            createPzStudio({ logger: thrown.logger }).run('list', [], {
                flags: ['--project', emptyDir],
            }),
        ).rejects.toBeInstanceOf(CliError);
        expect(thrown.calls.map((c) => c.method)).toEqual(['log', 'error']);
        expect(thrown.calls[0].message).toBe('\n');
        expect(String(thrown.calls[1].message)).toContain(
            'No pzstudio project found.',
        );
    });

    it('a legacy runCLI queues behind an active v2 run (shared engine lock, FIFO)', async () => {
        captureIO();
        const proj = makeProjectDir('ProjLock');
        const studio = createPzStudio();
        const events: string[] = [];
        let releaseA: () => void = () => {};
        const gateA = new Promise<void>((r) => {
            releaseA = r;
        });
        let pA: Promise<void> = Promise.resolve();
        let pB: Promise<void> = Promise.resolve();
        let restore: () => void = () => {};

        try {
            pA = studio.run('list', [], { flags: ['--project', proj] });

            restore = withCommandRun('list', async () => {
                events.push('a:start');
                await gateA;
                events.push('a:end');
            });
            await vi.waitFor(() => expect(events).toContain('a:start'));

            restore();
            restore = withCommandRun('list', async () => {
                events.push('b:start');
                events.push('b:end');
            });
            pB = runCLI('list', [], { flags: ['--project', proj] });

            releaseA();
            await Promise.all([pA, pB]);
        } finally {
            releaseA();
            restore();
            await Promise.allSettled([pA, pB]);
        }

        expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
        expect(getActiveInvocationContext()).toBeUndefined();
    });
});

describe('studio.resolveOutDir (doc 13 §10-A): the canonical dist-root reader', () => {
    const fakeHome = () => (globalThis as any).__PZSTUDIO_FAKE_HOME as string;

    function makeProject(title: string, outdir?: string): string {
        const dir = makeTempDir();
        fs.writeFileSync(
            path.join(dir, 'project.json'),
            JSON.stringify({
                workshop: { title, visibility: 'public', tags: [] },
                mods: {},
                excludes: [],
                ...(outdir === undefined ? {} : { outdir }),
            }),
        );
        return dir;
    }

    function writeGlobalConfig(outdir: string): void {
        fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
        fs.writeFileSync(getConfigPath(), JSON.stringify({ outdir }));
    }

    function caught(fn: () => unknown): unknown {
        try {
            fn();
        } catch (e) {
            return e;
        }
        return undefined;
    }

    it('returns the project dist root regardless of which outdir tiers are configured', () => {
        const combos: Array<() => PzStudioInstance> = [
            () => createPzStudio({ settings: () => undefined }),
            () =>
                createPzStudio({
                    settings: () => ({
                        workspace: { outdir: 'C:/ws-out' },
                        user: { outdir: 'C:/user-out' },
                    }),
                }),
            () => {
                writeGlobalConfig('C:/global-out');
                return createPzStudio({ settings: () => undefined });
            },
        ];
        for (const make of combos) {
            const proj = makeProject('TieredProject', 'project-out');
            expect(make().resolveOutDir(proj)).toBe(path.join(proj, 'dist'));
        }
    });

    it('a relative or tilde project outdir never leaks into the returned root', () => {
        const proj = makeProject('TokenProject', '~/Zomboid/Workshop');
        const nested = path.join(proj, 'src', 'content');
        fs.mkdirSync(nested, { recursive: true });
        const studio = createPzStudio();

        expect(studio.resolveOutDir(nested)).toBe(path.join(proj, 'dist'));
        expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'dist'));
    });

    it('resolves to an absolute, platform-native path', () => {
        const proj = makeProject('AbsRoot');
        const studio = createPzStudio({ settings: () => undefined });

        expect(path.isAbsolute(studio.resolveOutDir(proj))).toBe(true);
    });

    it('two project directories resolve independently — no cross-leak, and the provider receives exactly the requested projectDir', () => {
        const projA = makeProject('CrossA', 'out-a');
        const projB = makeProject('CrossB');
        const provider = vi.fn(() => undefined);
        const studio = createPzStudio({ settings: provider });

        expect(studio.resolveOutDir(projA)).toBe(path.join(projA, 'dist'));
        expect(studio.resolveOutDir(projB)).toBe(path.join(projB, 'dist'));

        expect(provider).toHaveBeenCalledTimes(2);
        expect(provider).toHaveBeenNthCalledWith(1, { projectDir: projA });
        expect(provider).toHaveBeenNthCalledWith(2, { projectDir: projB });
    });

    it('throws the structured no-project CliError when no project.json exists at or above the directory', () => {
        const emptyDir = makeTempDir();
        const studio = createPzStudio();

        const err = caught(() => studio.resolveOutDir(emptyDir));
        expect(err).toBeInstanceOf(CliError);
        const cliErr = err as CliError;
        expect(cliErr.message).toBe('No pzstudio project found.');
        expect(String(cliErr.cause)).toContain(emptyDir);
        expect(String(cliErr.tryHint)).toContain('pzstudio new');
    });

    it('throws the parse error for a corrupt project.json', () => {
        const proj = makeTempDir();
        fs.writeFileSync(path.join(proj, 'project.json'), '{ not json');
        const studio = createPzStudio();

        expect(String(caught(() => studio.resolveOutDir(proj)))).toContain(
            "Failed to parse 'project.json'",
        );
    });

    it('throws the validation error for an invalid project.json', () => {
        const proj = makeTempDir();
        fs.writeFileSync(
            path.join(proj, 'project.json'),
            JSON.stringify({ not: 'a project' }),
        );
        const studio = createPzStudio();

        expect(String(caught(() => studio.resolveOutDir(proj)))).toContain(
            'Validation failed for project.json',
        );
    });

    it('propagates a throwing settings provider', () => {
        const proj = makeProject('ProviderThrows');
        const studio = createPzStudio({
            settings: () => {
                throw new Error('provider boom');
            },
        });

        expect(String(caught(() => studio.resolveOutDir(proj)))).toContain(
            'provider boom',
        );
    });

    it('never consumes the legacy facade slots, even when every legacy setter is populated', () => {
        const proj = makeProject('LegacyBlind');
        const legacyProj = makeProject('LegacyAnchor', 'legacy-project-out');
        setProjectDir(legacyProj);
        setProjectRootAnchor(legacyProj);
        setVsCodeSettings({ outdir: 'C:/legacy-ws-out' });

        const spies = spyRawAccessors();
        const studio = createPzStudio({
            settings: () => ({ user: { outdir: 'C:/instance-out' } }),
        });

        expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'dist'));
        expect(spies.legacyLogger).not.toHaveBeenCalled();
        expect(spies.legacySettings).not.toHaveBeenCalled();
        expect(spies.legacyTransport).not.toHaveBeenCalled();
        expect(spies.externalDir).not.toHaveBeenCalled();
        expect(spies.legacyDiscoveryStart).not.toHaveBeenCalled();
    });

    it('repeated calls with unchanged settings return the same result (stateless, no hidden drift)', () => {
        const proj = makeProject('RepeatStable');
        const provider = vi.fn(() => ({
            workspace: { outdir: 'C:/stable-out' },
        }));
        const studio = createPzStudio({ settings: provider });

        expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'dist'));
        expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'dist'));
        expect(provider).toHaveBeenCalledTimes(2);
    });

    it('repeated calls re-read the settings provider every time (no caching)', () => {
        const proj = makeProject('RepeatChanged');
        const provider = vi.fn(() => ({ user: { outdir: 'C:/before-out' } }));
        const studio = createPzStudio({ settings: provider });

        expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'dist'));
        provider.mockReturnValue({ user: { outdir: 'C:/after-out' } });
        expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'dist'));
        expect(provider).toHaveBeenCalledTimes(2);
    });

    it('re-reads the fixture: a project.json outdir edit between calls does not move the dist root', () => {
        const proj = makeProject('EditBetweenCalls', 'original-out');
        const studio = createPzStudio({ settings: () => undefined });

        expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'dist'));

        const raw = JSON.parse(
            fs.readFileSync(path.join(proj, 'project.json'), 'utf8'),
        ) as any;
        raw.outdir = 'edited-out';
        fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify(raw));

        expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'dist'));
    });

    it('resolves while an engine run parks inside the FIFO lock — never queues behind it', async () => {
        captureIO();
        const proj = makeProject('LockFreeReader');
        const studio = createPzStudio({
            settings: () => ({ user: { outdir: 'C:/reader-out' } }),
        });

        const events: string[] = [];
        let releaseA: () => void = () => {};
        const gateA = new Promise<void>((r) => {
            releaseA = r;
        });
        let pA: Promise<void> = Promise.resolve();
        let restore: () => void = () => {};

        try {
            pA = studio.run('list', [], { flags: ['--project', proj] });
            restore = withCommandRun('list', async () => {
                events.push('a:start');
                await gateA;
                events.push('a:end');
            });
            await vi.waitFor(() => expect(events).toContain('a:start'));

            expect(studio.resolveOutDir(proj)).toBe(path.join(proj, 'dist'));

            expect(events).not.toContain('a:end');
        } finally {
            releaseA();
            restore();
            await pA.catch(() => {});
        }

        expect(events).toEqual(['a:start', 'a:end']);
    });
});
