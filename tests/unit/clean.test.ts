import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { cleanCmd } from '../../packages/cli/src/lib/commands/clean';
import { resolveProjectConfig } from '../../packages/cli/src/lib/helper';

vi.mock('fs');
vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/helper', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/helper')
    >()),
    resolveProjectConfig: vi.fn(),
}));

describe('cleanCmd', () => {
    const project = {
        workshop: { title: 'Test Project', visibility: 'public', tags: [] },
        mods: {},
        excludes: [],
        outdir: '/out',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(resolveProjectConfig).mockImplementation(
            () => JSON.parse(JSON.stringify(project)) as any,
        );
        vi.mocked(fs.existsSync).mockReturnValue(false as any);
    });

    it('should throw when executed outside of a project directory', () => {
        vi.mocked(resolveProjectConfig).mockReturnValue(undefined as any);

        expect(() => cleanCmd()).toThrow(
            'You must execute this command within a project directory!',
        );
    });

    it('should remove both the main and development outputs when they exist', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true as any);

        cleanCmd();

        expect(fs.rmSync).toHaveBeenCalledWith('/out/Test Project', {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
        });
        expect(fs.rmSync).toHaveBeenCalledWith(
            '/out/Test Project - dev_branch',
            { recursive: true, force: true, maxRetries: 5, retryDelay: 200 },
        );
    });

    it('should remove only the output that exists', () => {
        vi.mocked(fs.existsSync).mockImplementation((p: any) => {
            return String(p).replace(/\\/g, '/').endsWith('/out/Test Project');
        });

        cleanCmd();

        expect(fs.rmSync).toHaveBeenCalledTimes(1);
        expect(fs.rmSync).toHaveBeenCalledWith('/out/Test Project', {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
        });
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
            "Cannot delete '/out/Test Project' — the folder is in use by another program",
        );
        expect(fs.rmSync).toHaveBeenCalledWith(
            '/out/Test Project - dev_branch',
            { recursive: true, force: true, maxRetries: 5, retryDelay: 200 },
        );
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
        expect(message).toContain("Cannot delete '/out/Test Project' —");
        expect(message).toContain(
            "Cannot delete '/out/Test Project - dev_branch' —",
        );
    });

    it('should throw when there is no build output to clean', () => {
        expect(() => cleanCmd()).toThrow(
            "No build output found to clean (checked '/out/Test Project' and '/out/Test Project - dev_branch')",
        );
    });
});
