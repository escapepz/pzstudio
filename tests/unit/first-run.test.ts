import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { join } from 'path';
import {
    LANDING_URL_CLI,
    maybePrintFirstBuildUrl,
} from '../../packages/cli/src/lib/first-run';

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    const mocks = {
        existsSync: vi.fn(actual.existsSync),
        mkdirSync: vi.fn(actual.mkdirSync),
        writeFileSync: vi.fn(actual.writeFileSync),
    };
    return {
        ...actual,
        ...mocks,
        default: {
            ...actual.default,
            ...mocks,
        },
    };
});

const fakeHome = (): string =>
    (globalThis as any).__PZSTUDIO_FAKE_HOME as string;
const configDir = (): string => join(fakeHome(), '.pzstudio');
const markerPath = (): string => join(configDir(), '.first-build-url-shown');

describe('maybePrintFirstBuildUrl', () => {
    let lines: string[];

    beforeEach(async () => {
        vi.restoreAllMocks();
        const actualFs = await vi.importActual<typeof import('fs')>('fs');
        vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync as any);
        vi.mocked(fs.mkdirSync).mockImplementation(actualFs.mkdirSync as any);
        vi.mocked(fs.writeFileSync).mockImplementation(
            actualFs.writeFileSync as any,
        );
        vi.mocked(fs.existsSync).mockClear();
        vi.mocked(fs.mkdirSync).mockClear();
        vi.mocked(fs.writeFileSync).mockClear();
        lines = [];
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('prints the URL once and writes the marker', () => {
        expect(LANDING_URL_CLI).toBe(
            'https://escapepz.github.io/pzstudio/landing/?utm_source=cli-print',
        );
        expect(fs.existsSync(markerPath())).toBe(false);

        const printed = maybePrintFirstBuildUrl((line) => lines.push(line));

        expect(printed).toBe(true);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(
            'escapepz.github.io/pzstudio/landing/?utm_source=cli-print',
        );
        expect(lines[0].startsWith('See tips & updates -> ')).toBe(true);
        expect(fs.existsSync(markerPath())).toBe(true);
    });

    it('never prints again once the marker exists', () => {
        expect(maybePrintFirstBuildUrl((line) => lines.push(line))).toBe(true);
        expect(lines).toHaveLength(1);

        lines = [];
        const second = maybePrintFirstBuildUrl((line) => lines.push(line));

        expect(second).toBe(false);
        expect(lines).toHaveLength(0);
    });

    it('print-then-mark order: a failing write does not lose the print', () => {
        vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
            throw new Error('simulated marker write failure');
        });

        let printed: boolean;
        expect(() => {
            printed = maybePrintFirstBuildUrl((line) => lines.push(line));
        }).not.toThrow();

        expect(printed).toBe(true);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(
            'escapepz.github.io/pzstudio/landing/?utm_source=cli-print',
        );
        expect(fs.existsSync(markerPath())).toBe(false);
    });
});

describe('runtime-context standalone gate', () => {
    it('standalone gate', async () => {
        vi.resetModules();
        const ctx = await import('../../packages/cli/src/lib/runtime-context');

        expect(ctx.isStandaloneBin()).toBe(false);
        ctx.markStandaloneBin();
        expect(ctx.isStandaloneBin()).toBe(true);
    });
});
