import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { updateCmd } from '../../packages/cli/src/lib/commands/update';
import * as logger from '../../packages/cli/src/lib/logger';
import { CliError } from '../../packages/cli/src/lib/errors';
import { hasFlag } from '../../packages/cli/src/lib/args';
import {
    getConfigDir,
    refreshLegacyTemplates,
    resolveTemplateDirForEngine,
} from '../../packages/cli/src/lib/templateManager';

vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/templateManager');
vi.mock('../../packages/cli/src/lib/args', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('../../packages/cli/src/lib/args')
    >()),
    hasFlag: vi.fn(),
}));

describe('updateCmd — aggregate failure semantics (CLI-6)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getConfigDir).mockReturnValue('/fake-home/.pzstudio');
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
        vi.mocked(getConfigDir).mockReturnValue('/fake-home/.pzstudio');
    });

    it('U1 - up-to-date: the legacy step runs and its line reaches the output', async () => {
        vi.mocked(resolveTemplateDirForEngine).mockReturnValue('/tpl' as any);
        vi.mocked(refreshLegacyTemplates).mockImplementation(() => {
            logger.info('Legacy templates up to date.');
            return 'up-to-date';
        });
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

describe('updateCmd — output names the cache dirs and end states (d15-F2)', () => {
    const home = '/fake-home/.pzstudio';
    const cacheDir = `${home}/templates/escapepz/pzstudio-template-project`;
    const legacyDir = join(home, '.template-legacy', '.template-project');
    const legacyRoot = join(home, '.template-legacy');
    const templatesRoot = join(home, 'templates');

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getConfigDir).mockReturnValue(home);
        vi.mocked(resolveTemplateDirForEngine).mockReturnValue(cacheDir);
        vi.mocked(refreshLegacyTemplates).mockReturnValue('up-to-date');
    });

    it('per-category line names the resolved cache dir + updated end state', async () => {
        await updateCmd();

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                `- 'project' templates updated at: ${cacheDir}`,
            ),
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                `- 'language' templates updated at: ${cacheDir}`,
            ),
        );
    });

    it('per-category line names the legacy dir + fell-back end state when the cache did not answer', async () => {
        vi.mocked(resolveTemplateDirForEngine).mockReturnValue(legacyDir);

        await updateCmd();

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                `- 'project' templates fell back to legacy at: ${legacyDir}`,
            ),
        );
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                'All template caches refreshed successfully!',
            ),
        );
    });

    it('legacy leg names the global legacy root for every refresh end state', async () => {
        vi.mocked(refreshLegacyTemplates).mockReturnValue('refreshed');
        await updateCmd();
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                `- Legacy fallback templates refreshed at: ${legacyRoot}`,
            ),
        );

        vi.mocked(refreshLegacyTemplates).mockReturnValue('up-to-date');
        await updateCmd();
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                `- Legacy fallback templates already up to date at: ${legacyRoot}`,
            ),
        );

        vi.mocked(refreshLegacyTemplates).mockReturnValue('skipped');
        await updateCmd();
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                `- Legacy fallback templates skipped; global copy left at: ${legacyRoot}`,
            ),
        );
    });

    it('the success line names both cache roots', async () => {
        await updateCmd();

        const successLine = vi
            .mocked(logger.info)
            .mock.calls.map((call) => String(call[0]))
            .find((message) =>
                message.includes('All template caches refreshed successfully!'),
            );
        expect(successLine).toContain(templatesRoot);
        expect(successLine).toContain(legacyRoot);
    });
});

describe('updateCmd — json envelope (d11-F1)', () => {
    const home = '/fake-home/.pzstudio';
    const cacheDir = `${home}/templates/escapepz/pzstudio-template-project`;
    const legacyRoot = join(home, '.template-legacy');

    const jsonEnvelopes = (): any[] =>
        logger.log.mock.calls
            .map((call) => String(call[0]))
            .filter((t) => t.trim().startsWith('{'))
            .map((t) => JSON.parse(t));

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getConfigDir).mockReturnValue(home);
        vi.mocked(hasFlag).mockReturnValue(false as any);
    });

    it('update --json: one envelope with the per-category end states + legacy end state (d11-F1)', async () => {
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'json',
        );
        vi.mocked(resolveTemplateDirForEngine).mockReturnValue(cacheDir);
        vi.mocked(refreshLegacyTemplates).mockReturnValue('up-to-date' as any);
        vi.mocked(logger.engineIo).mockReturnValue({
            logger: {
                log: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                verbose: vi.fn(),
            },
        } as any);

        await updateCmd();

        const envelopes = jsonEnvelopes();
        expect(envelopes).toHaveLength(1);
        const envelope = envelopes[0];
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.command).toBe('update');
        expect(envelope.result.categories).toEqual([
            { category: 'project', state: 'updated', path: cacheDir },
            { category: 'mod', state: 'updated', path: cacheDir },
            { category: 'workshop', state: 'updated', path: cacheDir },
            { category: 'language', state: 'updated', path: cacheDir },
        ]);
        expect(envelope.result.legacy).toEqual({
            state: 'up-to-date',
            path: legacyRoot,
        });
    });

    it('a partially failed update still prints the envelope before the aggregate error (d11-F1)', async () => {
        vi.mocked(hasFlag).mockImplementation(
            (name: string) => name === 'json',
        );
        vi.mocked(resolveTemplateDirForEngine).mockImplementation(
            (category: any) => {
                if (category === 'workshop') {
                    throw new Error('git died');
                }
                return cacheDir;
            },
        );
        vi.mocked(refreshLegacyTemplates).mockReturnValue('up-to-date' as any);
        vi.mocked(logger.engineIo).mockReturnValue({
            logger: {
                log: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                verbose: vi.fn(),
            },
        } as any);

        await expect(updateCmd()).rejects.toThrow(CliError);

        const envelope = jsonEnvelopes()[0];
        expect(envelope.command).toBe('update');
        const workshop = envelope.result.categories.find(
            (entry: any) => entry.category === 'workshop',
        );
        expect(workshop).toEqual({ category: 'workshop', state: 'failed' });
        expect(envelope.result.legacy.state).toBe('up-to-date');
    });

    it('non-json update keeps stdout empty (human lines are stderr) (d11-F1 pin)', async () => {
        vi.mocked(resolveTemplateDirForEngine).mockReturnValue(cacheDir);
        vi.mocked(refreshLegacyTemplates).mockReturnValue('up-to-date' as any);
        vi.mocked(logger.engineIo).mockReturnValue({
            logger: {
                log: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                verbose: vi.fn(),
            },
        } as any);

        await updateCmd();

        expect(logger.log).not.toHaveBeenCalled();
    });
});
