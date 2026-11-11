import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import * as logger from '../../packages/cli/src/lib/logger';
import { cleanCmd } from '../../packages/cli/src/lib/commands/clean';
import {
    distRootOf,
    projectDir,
    resolveProjectConfig,
} from '../../packages/cli/src/lib/helper';

vi.mock('fs');
vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/helper', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/helper')
    >()),
    resolveProjectConfig: vi.fn(),
    projectDir: vi.fn(),
}));

describe('cleanCmd', () => {
    // Dist-always: clean removes the canonical dist output items; the
    // project's outdir (if any) is a deployment target, untouched here.
    // joinPosix folds separators, so normalize the anchor for assertions.
    const distRoot = distRootOf('/proj').replace(/\\/g, '/');
    const mainOut = `${distRoot}/Test Project`;
    const devOut = `${distRoot}/Test Project - dev_branch`;
    const rmOpts = {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(projectDir).mockReturnValue('/proj' as any);
        vi.mocked(resolveProjectConfig).mockImplementation(
            () =>
                JSON.parse(
                    JSON.stringify({
                        workshop: {
                            title: 'Test Project',
                            visibility: 'public',
                            tags: [],
                        },
                        mods: {},
                        excludes: [],
                        outdir: '/out',
                    }),
                ) as any,
        );
        vi.mocked(fs.existsSync).mockReturnValue(false as any);
    });

    it('should throw when executed outside of a project directory', () => {
        vi.mocked(resolveProjectConfig).mockReturnValue(undefined as any);

        expect(() => cleanCmd()).toThrow('No pzstudio project found.');
    });

    it('should remove both the main and development dist outputs when they exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true as any);

        cleanCmd();

        expect(fs.rmSync).toHaveBeenCalledWith(mainOut, rmOpts);
        expect(fs.rmSync).toHaveBeenCalledWith(devOut, rmOpts);
        // The configured deployment outdir is never a clean target.
        expect(fs.rmSync).not.toHaveBeenCalledWith(
            expect.stringContaining('/out/'),
            expect.anything(),
        );
    });

    it('should remove only the output that exists', () => {
        vi.mocked(fs.existsSync).mockImplementation((p: any) => {
            return String(p).replace(/\\/g, '/').endsWith('/Test Project');
        });

        cleanCmd();

        expect(fs.rmSync).toHaveBeenCalledTimes(1);
        expect(fs.rmSync).toHaveBeenCalledWith(mainOut, rmOpts);
    });

    it('should still attempt the dev output when the main output is locked', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true as any);
        vi.mocked(fs.rmSync).mockImplementation((p: any) => {
            if (!String(p).replace(/\\/g, '/').includes('dev_branch')) {
                const e = new Error('not empty') as NodeJS.ErrnoException;
                e.code = 'ENOTEMPTY';
                throw e;
            }
        });

        expect(() => cleanCmd()).toThrow(
            `Cannot delete '${mainOut}' — the folder is in use by another program`,
        );
        expect(fs.rmSync).toHaveBeenCalledWith(devOut, rmOpts);
    });

    it('should report a combined error when both outputs are locked', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true as any);
        vi.mocked(fs.rmSync).mockImplementation(() => {
            const e = new Error('not empty') as NodeJS.ErrnoException;
            e.code = 'ENOTEMPTY';
            throw e;
        });

        let message = '';
        try {
            cleanCmd();
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toContain(`Cannot delete '${mainOut}' —`);
        expect(message).toContain(`Cannot delete '${devOut}' —`);
    });

    it('should succeed with Already clean when there is no build output (CLI-6)', () => {
        // Nothing to clean is a clean result: exit 0, no throw.
        cleanCmd();
        expect(logger.log).toHaveBeenCalledWith('Already clean.');
    });
});
