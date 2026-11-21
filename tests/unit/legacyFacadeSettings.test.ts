'use strict';

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

    it('runCLI build writes dist and materializes a junction at the configured outdir', async () => {
        const proj = makeProject('Facade Build');
        withNonDefaultConfig(customOut, false);
        pushLegacyLayers(customOut, true);
        setProjectDir(proj);
        await runCLI('build', [], { flags: [] });

        expect(
            fs.existsSync(
                path.join(proj, 'dist', 'Facade Build', 'workshop.txt'),
            ),
        ).toBe(true);
        expect(
            fs.lstatSync(path.join(customOut, 'Facade Build')).isSymbolicLink(),
        ).toBe(true);
        expect(
            fs.existsSync(
                path.join(defaultWorkshopDir(), 'Facade Build', 'workshop.txt'),
            ),
        ).toBe(false);
    });

    it('legacy createDevSync plan input writes the project dist root (slots are never write targets)', async () => {
        pushLegacyLayers(customOut);
        const proj = makeProject('Facade Sync');
        const workshopTemplateDir = path.join(makeTemp(), 'tpl-workshop');
        fs.mkdirSync(workshopTemplateDir, { recursive: true });
        const session = createDevSync(proj, { workshopTemplateDir });
        try {
            await session.start(['main']);
        } finally {
            await session.stop();
        }

        expect(fs.existsSync(path.join(proj, 'dist', 'Facade Sync'))).toBe(
            true,
        );
        expect(fs.existsSync(path.join(customOut, 'Facade Sync'))).toBe(false);
        expect(
            fs.existsSync(path.join(defaultWorkshopDir(), 'Facade Sync')),
        ).toBe(false);
    });

    it('legacy runProjectDoctor resolves the configured outdir and template layers', async () => {
        pushLegacyLayers(customOut);
        const proj = makeProject('Facade Doctor');

        const report = await runProjectDoctor(proj);

        const outDirMissing = outDirMissingMessages(report);
        expect(outDirMissing).toHaveLength(1);
        expect(outDirMissing[0]).toContain(customOut);
        const notCached = report.diagnostics.find(
            (d) => d.code === 'templates.notCached',
        );
        expect(notCached?.message).toContain('bridge/workshop-fixture');
    });

    it('runCLI build with empty legacy slots runs pure: dist only, no deployment', async () => {
        withNonDefaultConfig(customOut, false);
        const proj = makeProject('Facade Build Bare');

        setProjectDir(proj);
        await runCLI('build', [], { flags: [] });

        expect(
            fs.existsSync(
                path.join(proj, 'dist', 'Facade Build Bare', 'workshop.txt'),
            ),
        ).toBe(true);
        expect(
            fs.existsSync(
                path.join(
                    defaultWorkshopDir(),
                    'Facade Build Bare',
                    'workshop.txt',
                ),
            ),
        ).toBe(false);
        expect(fs.existsSync(path.join(customOut, 'Facade Build Bare'))).toBe(
            false,
        );
    });
});
