import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    isExperimentalIntegrationEnabled,
    updateExperimentalScripts,
} from '../../packages/cli/src/lib/helper';
import { readGlobalConfig } from '../../packages/cli/src/lib/templateManager';

vi.mock('../../packages/cli/src/lib/templateManager');

describe('experimental integration opt-in (CLI-10, BREAKING)', () => {
    const tempDirs: string[] = [];

    function makeProject(projectConfig?: object): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-experimental-'));
        tempDirs.push(dir);
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({ name: 'proj', scripts: {} }, null, 4),
        );
        if (projectConfig !== undefined) {
            fs.writeFileSync(
                path.join(dir, 'project.json'),
                JSON.stringify(projectConfig, null, 4),
            );
        }
        return dir;
    }

    function injectedScripts(dir: string): Record<string, string> {
        const pkg = JSON.parse(
            fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
        );
        return pkg.scripts ?? {};
    }

    beforeEach(() => {
        vi.mocked(readGlobalConfig).mockReturnValue({} as any);
    });

    afterEach(() => {
        while (tempDirs.length) {
            fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
        }
    });

    it('is disabled by default — no settings anywhere, nothing injected', () => {
        const dir = makeProject();

        expect(isExperimentalIntegrationEnabled(dir)).toBe(false);

        updateExperimentalScripts('addProject', dir);
        expect(injectedScripts(dir)).toEqual({});
    });

    it('is disabled when the project explicitly sets integration to false', () => {
        const dir = makeProject({
            workshop: { title: 'T', visibility: 'public', tags: [] },
            mods: {},
            experimental: { integration: false },
        });

        expect(isExperimentalIntegrationEnabled(dir)).toBe(false);
        updateExperimentalScripts('addProject', dir);
        expect(injectedScripts(dir)).toEqual({});
    });

    it('is enabled by an explicit project.json setting', () => {
        const dir = makeProject({
            workshop: { title: 'T', visibility: 'public', tags: [] },
            mods: {},
            experimental: { integration: true },
        });

        expect(isExperimentalIntegrationEnabled(dir)).toBe(true);

        updateExperimentalScripts('addProject', dir);
        expect(injectedScripts(dir)['experimental:setup:vanilla']).toContain(
            'mklink /J',
        );

        updateExperimentalScripts('addMod', dir, 'my_mod');
        expect(
            injectedScripts(dir)['experimental:setup:nonsteam:my_mod'],
        ).toContain('my_mod');
    });

    it('falls back to an explicit global config setting when the project is silent', () => {
        // project.json exists but carries no experimental key at all.
        const dir = makeProject({
            workshop: { title: 'T', visibility: 'public', tags: [] },
            mods: {},
        });
        vi.mocked(readGlobalConfig).mockReturnValue({
            experimental: { integration: true },
        } as any);

        expect(isExperimentalIntegrationEnabled(dir)).toBe(true);
        updateExperimentalScripts('addProject', dir);
        expect(
            injectedScripts(dir)['experimental:setup:vanilla'],
        ).toBeDefined();
    });

    it('gives the explicit project setting precedence over the global config (false wins)', () => {
        const dir = makeProject({
            workshop: { title: 'T', visibility: 'public', tags: [] },
            mods: {},
            experimental: { integration: false },
        });
        vi.mocked(readGlobalConfig).mockReturnValue({
            experimental: { integration: true },
        } as any);

        expect(isExperimentalIntegrationEnabled(dir)).toBe(false);
        updateExperimentalScripts('addProject', dir);
        expect(injectedScripts(dir)).toEqual({});
    });

    it('gives the explicit project setting precedence over the global config (true wins)', () => {
        const dir = makeProject({
            workshop: { title: 'T', visibility: 'public', tags: [] },
            mods: {},
            experimental: { integration: true },
        });
        vi.mocked(readGlobalConfig).mockReturnValue({
            experimental: { integration: false },
        } as any);

        expect(isExperimentalIntegrationEnabled(dir)).toBe(true);
        updateExperimentalScripts('addProject', dir);
        expect(
            injectedScripts(dir)['experimental:setup:vanilla'],
        ).toBeDefined();
    });

    it('an explicit global false keeps the integration off', () => {
        const dir = makeProject();
        vi.mocked(readGlobalConfig).mockReturnValue({
            experimental: { integration: false },
        } as any);

        expect(isExperimentalIntegrationEnabled(dir)).toBe(false);
        updateExperimentalScripts('addProject', dir);
        expect(injectedScripts(dir)).toEqual({});
    });
});
