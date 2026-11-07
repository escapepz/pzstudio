'use strict';

/**
 * Legacy CLI facade settings compatibility (doc 11 §13/§13.1; commit 11).
 *
 * The extension's transitional settings push bridge (updateVsCodeSettings →
 * setVsCodeSettings) was retired in commit 11 — the extension's every
 * operation path resolves settings through its v2 instance provider
 * (pinned in extUtilSettings.test.ts + extActivation.test.ts) and no
 * extension runtime code writes the legacy slots anymore.
 *
 * What remains public contract is the CLI's own legacy facade: an external
 * consumer of `@pzstudio/cli/api` calls `setVsCodeSettings(ws, user)`
 * DIRECTLY and every legacy door observes the slots. These tests pin that
 * contract for the three frozen §13 non-engine legacy doors (runCLI,
 * legacy createDevSync, legacy runProjectDoctor), setting up the slots
 * exactly the way an external consumer does — never through removed
 * extension code.
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
import * as api from '@pzstudio/cli/api';
import {
    runCLI,
    setProjectDir,
    createDevSync,
    runProjectDoctor,
    setVsCodeSettings,
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

/**
 * The exact layers the extension's retired push bridge used to push (the
 * extUtilSettings reader snapshot shape). An external consumer of the
 * legacy facade sets up the slots DIRECTLY like this — same layer shapes,
 * same workspaceValue/globalValue semantics (§10).
 *
 * withWorkshopTemplate: template resolution REPLACES the global config
 * templates wholesale when the host layers define any template
 * (`vscodeSettings?.templates ?? globalConfig.templates`,
 * templateManager.ts) — per-category fallback against the global defaults
 * does not exist. A slot-fed build therefore needs the workshop category
 * pushed alongside the project one. The pushed workshop entry keeps the
 * OFFICIAL default URL (DEFAULT_TEMPLATES.workshop): the offline legacy
 * fallback only exists for official templates, so this mirrors a consumer
 * who customized the project template but left workshop at its default —
 * and keeps the test hermetic (blocked clone → embedded legacy template,
 * the same path the empty-slots test takes).
 */
function pushLegacyLayers(
    customOut: string,
    withWorkshopTemplate = false,
): void {
    setVsCodeSettings(
        {
            templates: {
                project: {
                    url: 'https://github.com/bridge/workshop-fixture.git',
                },
                ...(withWorkshopTemplate
                    ? {
                          workshop: {
                              url: 'https://github.com/escapepz/pzstudio-template-workshop.git',
                              ref: '42.0',
                          },
                      }
                    : {}),
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
}

const defaultWorkshopDir = () =>
    path.join(getFakeHome()!, 'Zomboid', 'Workshop');

function outDirMissingMessages(report: DoctorReport): string[] {
    return report.diagnostics
        .filter((d) => d.code === 'filesystem.outDirMissing')
        .map((d) => d.message);
}

/* ------------------------------------------------------------------ */
/* Legacy CLI facade contract: slots feed the legacy doors             */
/* ------------------------------------------------------------------ */

describe('legacy CLI facade settings (external consumers feed the slots directly)', () => {
    let customOut: string;

    beforeEach(() => {
        vi.clearAllMocks();
        api.setVsCodeSettings(undefined, undefined);
        setProjectDir(undefined);
        customOut = path.join(makeTemp(), 'custom-out');
        withNonDefaultConfig(customOut);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        api.setVsCodeSettings(undefined, undefined);
        setProjectDir(undefined);
        for (const dir of temps) deleteDir(dir);
        temps = [];
    });

    it('runCLI build lands in the configured outdir', async () => {
        const proj = makeProject('Facade Build');
        withNonDefaultConfig(customOut, false);
        // Build resolves the workshop template category, so the pushed
        // workshop layer (official default URL) rides along — see
        // pushLegacyLayers. Hermetic: the clone fails instantly in this
        // network-blocked suite and the CLI falls back to the embedded
        // legacy template — the same offline path the empty-slots test
        // below exercises.
        pushLegacyLayers(customOut, true);
        setProjectDir(proj);
        await runCLI('build', [], { flags: [] });

        expect(
            fs.existsSync(path.join(customOut, 'Facade Build', 'workshop.txt')),
        ).toBe(true);
        expect(
            fs.existsSync(
                path.join(defaultWorkshopDir(), 'Facade Build', 'workshop.txt'),
            ),
        ).toBe(false);
    });

    it('legacy createDevSync plan input lands in the configured outdir', async () => {
        pushLegacyLayers(customOut); // direct slot write
        const proj = makeProject('Facade Sync');
        // Hermetic template short-circuit only — the plan input still
        // resolves outdir from the legacy slots.
        const workshopTemplateDir = path.join(makeTemp(), 'tpl-workshop');
        fs.mkdirSync(workshopTemplateDir, { recursive: true });
        const session = createDevSync(proj, { workshopTemplateDir });
        try {
            await session.start(['main']);
        } finally {
            await session.stop();
        }

        expect(fs.existsSync(path.join(customOut, 'Facade Sync'))).toBe(true);
        expect(
            fs.existsSync(path.join(defaultWorkshopDir(), 'Facade Sync')),
        ).toBe(false);
    });

    it('legacy runProjectDoctor resolves the configured outdir and template layers', async () => {
        pushLegacyLayers(customOut); // direct slot write
        const proj = makeProject('Facade Doctor');

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

    it('runCLI build with empty legacy slots falls back to the default outdir', async () => {
        // The mirror of the slot-fed case: empty slots → tier falls through
        // to the default workshop dir (§13.1 post-run state semantics).
        withNonDefaultConfig(customOut, false);
        const proj = makeProject('Facade Build Bare');

        setProjectDir(proj);
        await runCLI('build', [], { flags: [] });

        expect(
            fs.existsSync(
                path.join(
                    defaultWorkshopDir(),
                    'Facade Build Bare',
                    'workshop.txt',
                ),
            ),
        ).toBe(true);
        expect(
            fs.existsSync(
                path.join(customOut, 'Facade Build Bare', 'workshop.txt'),
            ),
        ).toBe(false);
    });
});
