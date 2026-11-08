import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { join } from 'path';
import {
    LANDING_URL_CLI,
    maybePrintFirstBuildUrl,
} from '../../packages/cli/src/lib/first-run';

// Mock factory (same shape as usageRecorder.test.ts / templateManager.test.ts):
// keeps the module-graph fs shared so a vi.spyOn(fs, 'writeFileSync') in a
// case below reaches first-run.ts's named import; the fns start as the real
// implementations and are re-primed per test, so cases verify real-file
// behavior through the module under test.
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

/**
 * First-run URL print (one-time, marker-file pinned). The marker directory
 * resolves through getConfigDir() → os.homedir(), which vitest.setup.ts
 * pins to a fresh fake home per test — the same pattern
 * tests/unit/templateManager.test.ts uses for its stamp cases, so every
 * case here verifies real-file behavior through the module under test.
 */
const fakeHome = (): string =>
    (globalThis as any).__PZSTUDIO_FAKE_HOME as string;
const configDir = (): string => join(fakeHome(), '.pzstudio');
const markerPath = (): string => join(configDir(), '.first-build-url-shown');

describe('maybePrintFirstBuildUrl', () => {
    let lines: string[];

    beforeEach(async () => {
        vi.restoreAllMocks();
        // Vitest 4's restoreAllMocks resets the vi.fn(actual.*) wrappers the
        // fs mock factory installed, so re-prime them with the real
        // implementations and clear the call records for isolation.
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
        // The exported landing URL is pinned verbatim (spec constant).
        expect(LANDING_URL_CLI).toBe(
            'https://escapepz.github.io/pzstudio/?utm_source=cli-print',
        );
        expect(fs.existsSync(markerPath())).toBe(false);

        const printed = maybePrintFirstBuildUrl((line) => lines.push(line));

        expect(printed).toBe(true);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(
            'escapepz.github.io/pzstudio/?utm_source=cli-print',
        );
        // The CTA line reads as the closing note of a successful build.
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
        // Windows cannot make a directory write-protected via chmod, so the
        // failure is simulated at the write call (same shape as the C7
        // copy-failure simulation in templateManager.test.ts): the print
        // must already have happened when the marker write throws, and the
        // swallowed failure must not escape the call.
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
            'escapepz.github.io/pzstudio/?utm_source=cli-print',
        );
        // The write really failed: no marker may be stranded behind it.
        expect(fs.existsSync(markerPath())).toBe(false);
    });
});

describe('runtime-context standalone gate', () => {
    it('standalone gate', async () => {
        // Fresh module state: the gate is process-wide (module-level flag),
        // so import freshness is what a new standalone bin run would see.
        vi.resetModules();
        const ctx = await import('../../packages/cli/src/lib/runtime-context');

        expect(ctx.isStandaloneBin()).toBe(false);
        ctx.markStandaloneBin();
        expect(ctx.isStandaloneBin()).toBe(true);
    });
});
