'use strict';

/**
 * TRANSITIONAL SETTINGS BRIDGE regression tests (doc 11 §17 commit 7 as
 * corrected).
 *
 * During the consumer-migration window the extension still hosts LEGACY
 * consumers — `runProjectDoctor` and the modinfo command (the build task
 * provider joined the v2 host instance in commit 8, the DevSync controller
 * in commit 9 — the `createDevSync` cases below now pin the frozen §13
 * legacy facade rather than an extension consumer). Per
 * R1 they read ONLY the raw legacy settings slots (`legacySettings()` /
 * the legacy facade), never
 * the v2 provider or an ambient context, so the extension must keep
 * pushing the configured workspace/global snapshot via
 * `updateVsCodeSettings()`. These tests prove, with NON-DEFAULT settings,
 * that each legacy operation sees the configured values right after the
 * activation-time push — and the mirror cases prove the slots are the sole
 * source (no push = the values are lost), which is exactly what would
 * happen if the bridge were dropped early.
 *
 * Everything runs against the real `@pzstudio/cli/api` (the same module the
 * extension bundle inlines): only `vscode` is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('../helpers/vscode-mock');
    return createVscodeMock();
});

import * as vscode from 'vscode';
import { getFakeHome } from '../helpers/fake-home';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import {
    updateVsCodeSettings,
    subscribeToConfigurationChanges,
    readPzStudioHostSettings,
} from '../../packages/vscode-extension/src/util/settings';
import {
    BuildTaskProvider,
    PZ_TASK_TYPE,
} from '../../packages/vscode-extension/src/providers/buildTaskProvider';
import * as api from '@pzstudio/cli/api';
import {
    runCLI,
    setProjectDir,
    createDevSync,
    runProjectDoctor,
} from '@pzstudio/cli/api';
import type { DoctorReport } from '@pzstudio/cli/api';

const asMock = <T>(fn: unknown) => fn as unknown as import('vitest').Mock<T>;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

let temps: string[] = [];
function makeTemp(): string {
    const dir = createTempDir();
    temps.push(dir);
    return dir;
}

function makeProject(title: string): string {
    const dir = makeTemp();
    fs.writeFileSync(
        path.join(dir, 'project.json'),
        JSON.stringify({
            workshop: { title, visibility: 'public', tags: [] },
            mods: {
                bridge_mod: { name: 'Bridge Mod', description: 'tmp' },
            },
            excludes: [],
        }),
    );
    fs.mkdirSync(path.join(dir, 'bridge_mod', '42', 'media', 'lua'), {
        recursive: true,
    });
    fs.writeFileSync(
        path.join(dir, 'bridge_mod', '42', 'media', 'lua', 'main.lua'),
        'print("bridge")',
    );
    return dir;
}

/** Non-default configuration: custom outdir, no symlinks, custom template. */
function withNonDefaultConfig(customOut: string, withTemplates = true) {
    asMock(vscode.workspace.getConfiguration).mockImplementation(
        (section: string) => {
            if (section === 'pzstudio') {
                return {
                    get: vi.fn(),
                    inspect: vi.fn((key: string) => {
                        if (key === 'outdir') {
                            return { workspaceValue: customOut };
                        }
                        if (key === 'useSymlinks') {
                            return { workspaceValue: false };
                        }
                        return undefined;
                    }),
                    update: vi.fn(),
                } as never;
            }
            if (withTemplates && section === 'pzstudio.templates.project') {
                return {
                    get: vi.fn(),
                    inspect: vi.fn((key: string) =>
                        key === 'url'
                            ? {
                                  workspaceValue:
                                      'https://github.com/bridge/workshop-fixture.git',
                              }
                            : undefined,
                    ),
                    update: vi.fn(),
                } as never;
            }
            return {
                get: vi.fn(),
                inspect: vi.fn(() => undefined),
                update: vi.fn(),
            } as never;
        },
    );
}

const defaultWorkshopDir = () =>
    path.join(getFakeHome()!, 'Zomboid', 'Workshop');

function outDirMissingMessages(report: DoctorReport): string[] {
    return report.diagnostics
        .filter((d) => d.code === 'filesystem.outDirMissing')
        .map((d) => d.message);
}

/* ------------------------------------------------------------------ */
/* Regression: each legacy consumer still sees the configured settings  */
/* ------------------------------------------------------------------ */

describe('transitional settings bridge (legacy consumers keep their settings)', () => {
    let customOut: string;
    let pushSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        api.setVsCodeSettings(undefined, undefined);
        setProjectDir(undefined);
        customOut = path.join(makeTemp(), 'custom-out');
        withNonDefaultConfig(customOut);
        // Spy over the REAL slot write: the extension bridge must keep
        // feeding exactly these slots (R1 consumers read nothing else).
        pushSpy = vi.spyOn(api, 'setVsCodeSettings');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        api.setVsCodeSettings(undefined, undefined);
        setProjectDir(undefined);
        for (const dir of temps) deleteDir(dir);
        temps = [];
    });

    it('pushes the configured workspace/global layers into the legacy slots', () => {
        updateVsCodeSettings();

        // The slots now hold exactly the configured non-default layers —
        // byte-for-byte what the pre-migration bridge pushed.
        expect(pushSpy).toHaveBeenCalledWith(
            {
                templates: {
                    project: {
                        url: 'https://github.com/bridge/workshop-fixture.git',
                    },
                },
                outdir: customOut,
                useSymlinks: false,
            },
            {
                templates: undefined,
                outdir: undefined,
                useSymlinks: undefined,
            },
        );
    });

    it('re-pushes through the configuration listener when settings change', () => {
        const disposable = subscribeToConfigurationChanges();
        try {
            pushSpy.mockClear();
            asMock(vscode.workspace.onDidChangeConfiguration)
                .mock.calls.map((call) => call[0] as (e: unknown) => void)
                .forEach((handler) =>
                    handler({
                        affectsConfiguration: (section: string) =>
                            section === 'pzstudio' ||
                            section.startsWith('pzstudio.'),
                    }),
                );

            expect(pushSpy).toHaveBeenCalledWith(
                expect.objectContaining({ outdir: customOut }),
                expect.anything(),
            );
        } finally {
            disposable.dispose();
        }
    });

    it('task-provider build lands in the configured outdir', async () => {
        updateVsCodeSettings(); // the activation-time push
        const proj = makeProject('Bridge Task');

        // The engine build the task provider used to perform through the
        // legacy slots (it reads the same workspace/global layers via its v2
        // instance provider since commit 8 — the push bridge is what keeps
        // the still-legacy doctor consumer fed). No template
        // layers pushed: with any template layer present the
        // engine stops falling through to global defaults for the other
        // categories (pre-existing CLI semantics) — the template layer's
        // reach is proven by the doctor tests below.
        withNonDefaultConfig(customOut, false);
        updateVsCodeSettings();
        setProjectDir(proj);
        await runCLI('build', [], { flags: [] });

        expect(
            fs.existsSync(path.join(customOut, 'Bridge Task', 'workshop.txt')),
        ).toBe(true);
        expect(
            fs.existsSync(
                path.join(defaultWorkshopDir(), 'Bridge Task', 'workshop.txt'),
            ),
        ).toBe(false);
    });

    it('task-provider build without the bridge falls back to the default outdir (the regression this bridge prevents)', async () => {
        // NO push — the state the extension would be in without the bridge.
        withNonDefaultConfig(customOut, false);
        const proj = makeProject('Bridge Task Bare');

        setProjectDir(proj);
        await runCLI('build', [], { flags: [] });

        expect(
            fs.existsSync(
                path.join(
                    defaultWorkshopDir(),
                    'Bridge Task Bare',
                    'workshop.txt',
                ),
            ),
        ).toBe(true);
        expect(
            fs.existsSync(
                path.join(customOut, 'Bridge Task Bare', 'workshop.txt'),
            ),
        ).toBe(false);
    });

    it('DevSync plan input lands in the configured outdir', async () => {
        updateVsCodeSettings();
        const proj = makeProject('Bridge Sync');
        // Hermetic template short-circuit only — the plan input still
        // resolves outdir from the pushed legacy slots.
        const workshopTemplateDir = path.join(makeTemp(), 'tpl-workshop');
        fs.mkdirSync(workshopTemplateDir, { recursive: true });
        const session = createDevSync(proj, { workshopTemplateDir });
        try {
            await session.start(['main']);
        } finally {
            await session.stop();
        }

        expect(fs.existsSync(path.join(customOut, 'Bridge Sync'))).toBe(true);
        expect(
            fs.existsSync(path.join(defaultWorkshopDir(), 'Bridge Sync')),
        ).toBe(false);
    });

    it('DevSync plan input without the bridge falls back to the default outdir (the regression this bridge prevents)', async () => {
        // NO push — the state the extension would be in without the bridge.
        const workshopTemplateDir = path.join(makeTemp(), 'tpl-workshop');
        fs.mkdirSync(workshopTemplateDir, { recursive: true });
        const proj = makeProject('Bridge Sync Bare');
        const session = createDevSync(proj, { workshopTemplateDir });
        try {
            await session.start(['main']);
        } finally {
            await session.stop();
        }

        expect(
            fs.existsSync(path.join(defaultWorkshopDir(), 'Bridge Sync Bare')),
        ).toBe(true);
        expect(fs.existsSync(path.join(customOut, 'Bridge Sync Bare'))).toBe(
            false,
        );
    });

    it('doctor run resolves the configured outdir and template layers', async () => {
        updateVsCodeSettings();
        const proj = makeProject('Bridge Doctor');

        const report = await runProjectDoctor(proj);

        // The outdir tier took the pushed workspace value...
        const outDirMissing = outDirMissingMessages(report);
        expect(outDirMissing).toHaveLength(1);
        expect(outDirMissing[0]).toContain(customOut);
        // ...and the template probe saw the pushed templates.project layer
        // (cache never downloaded → info diagnostic naming it).
        const notCached = report.diagnostics.find(
            (d) => d.code === 'templates.notCached',
        );
        expect(notCached?.message).toContain('bridge/workshop-fixture');
    });

    it('doctor run without the bridge loses both configured layers (the regression this bridge prevents)', async () => {
        // NO push — the state the extension would be in without the bridge.
        const proj = makeProject('Bridge Doctor Bare');

        const report = await runProjectDoctor(proj);

        const outDirMissing = outDirMissingMessages(report);
        // The outdir tier fell through to the default — the configured
        // workspace value never reached the legacy consumer.
        expect(outDirMissing[0]).not.toContain(customOut);
        expect(outDirMissing[0]).toContain(defaultWorkshopDir());
        // The configured custom template never reached the probe either
        // (any remaining template diagnostic names the built-in default).
        expect(
            report.diagnostics.some((d) =>
                d.message.includes('bridge/workshop-fixture'),
            ),
        ).toBe(false);
    });

    it('serves the v2 provider the exact snapshot the bridge pushes', () => {
        // The two tiers must never drift: the pure provider (v2 runner) and
        // the compatibility push (legacy consumers) share one snapshot.
        updateVsCodeSettings();
        const [pushedWorkspace, pushedUser] = pushSpy.mock.calls[0];

        const provided = readPzStudioHostSettings({ projectDir: 'x' });
        expect(pushedWorkspace).toEqual(provided.workspace);
        expect(pushedUser).toEqual(provided.user);
    });
});
