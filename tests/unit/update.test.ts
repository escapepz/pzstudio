import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateCmd } from '../../packages/cli/src/lib/commands/update';
import * as logger from '../../packages/cli/src/lib/logger';
import { CliError } from '../../packages/cli/src/lib/errors';
import {
    refreshLegacyTemplates,
    resolveTemplateDirForEngine,
} from '../../packages/cli/src/lib/templateManager';

vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/templateManager');

describe('updateCmd — aggregate failure semantics (CLI-6)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('succeeds with the success summary when every category refreshes', async () => {
        vi.mocked(resolveTemplateDirForEngine).mockReturnValue('/tpl' as any);

        await updateCmd();

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                'All template caches refreshed successfully!',
            ),
        );
    });

    it('fails with a summary when some categories fail (partial refresh)', async () => {
        vi.mocked(resolveTemplateDirForEngine).mockImplementation(
            (category: any) => {
                if (category === 'workshop') {
                    throw new Error('git died');
                }
                return '/tpl' as any;
            },
        );

        await expect(updateCmd()).rejects.toThrow(
            'Refreshed 3/4 template caches — 1 update(s) failed.',
        );
        // The failing category is still warned per-category.
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Failed to update workshop template'),
        );
    });

    it('fails when every category fails', async () => {
        vi.mocked(resolveTemplateDirForEngine).mockImplementation(() => {
            throw new Error('offline');
        });

        await expect(updateCmd()).rejects.toThrow(
            'Refreshed 0/4 template caches — 4 update(s) failed.',
        );
    });
});

describe('updateCmd — legacy template cache refresh', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('U1 - up-to-date: the legacy step runs and its line reaches the output', async () => {
        vi.mocked(resolveTemplateDirForEngine).mockReturnValue('/tpl' as any);
        // The real refreshLegacyTemplates owns its emission lines through
        // the io scope (update.ts threads the engine scope); the mock
        // stands in for that contract — emit the status line, then return
        // the status.
        vi.mocked(refreshLegacyTemplates).mockImplementation(() => {
            logger.info('Legacy templates up to date.');
            return 'up-to-date';
        });
        // The logger module is auto-mocked, so engineIo() would return
        // undefined here; pin the scope the refresh must receive.
        const engineScope = {
            logger: {
                log: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                verbose: vi.fn(),
            },
        };
        vi.mocked(logger.engineIo).mockReturnValue(engineScope as any);

        await expect(updateCmd()).resolves.toBeUndefined();

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('- Updating legacy fallback templates...'),
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Legacy templates up to date.'),
        );
        // update.ts threads the engine io scope so the refresh emissions
        // keep their §12 ambient routing (invocation logger under
        // studio.run, raw legacy for the standalone CLI).
        expect(vi.mocked(refreshLegacyTemplates)).toHaveBeenCalledWith(
            engineScope,
        );
    });

    it('U2 - legacy refresh failure: CliError with the legacy-only message', async () => {
        vi.mocked(resolveTemplateDirForEngine).mockReturnValue('/tpl' as any);
        vi.mocked(refreshLegacyTemplates).mockImplementation(() => {
            throw new Error('boom');
        });

        const err: any = await updateCmd().then(
            () => {
                throw new Error('expected updateCmd to reject');
            },
            (e) => e,
        );

        expect(err).toBeInstanceOf(CliError);
        expect(err.message).toContain('legacy template refresh failed');
        // The failure is warned in place before it flips the exit code.
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Failed to refresh legacy templates: boom'),
        );
    });

    it('U3 - refreshed: refresh line emitted, single success line kept', async () => {
        vi.mocked(resolveTemplateDirForEngine).mockReturnValue('/tpl' as any);
        vi.mocked(refreshLegacyTemplates).mockImplementation(() => {
            logger.info('Legacy templates refreshed (42.20.0, 2026-11-07).');
            return 'refreshed';
        });

        await updateCmd();

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('Legacy templates refreshed'),
        );
        const successLines = vi
            .mocked(logger.info)
            .mock.calls.filter((call) =>
                String(call[0]).includes(
                    'All template caches refreshed successfully!',
                ),
            );
        expect(successLines).toHaveLength(1);
    });
});
