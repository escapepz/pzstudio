import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateCmd } from '../../packages/cli/src/lib/commands/update';
import * as logger from '../../packages/cli/src/lib/logger';
import { resolveTemplateDir } from '../../packages/cli/src/lib/templateManager';

vi.mock('../../packages/cli/src/lib/logger');
vi.mock('../../packages/cli/src/lib/templateManager');

describe('updateCmd — aggregate failure semantics (CLI-6)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('succeeds with the success summary when every category refreshes', async () => {
        vi.mocked(resolveTemplateDir).mockReturnValue('/tpl' as any);

        await updateCmd();

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                'All template caches refreshed successfully!',
            ),
        );
    });

    it('fails with a summary when some categories fail (partial refresh)', async () => {
        vi.mocked(resolveTemplateDir).mockImplementation((category: any) => {
            if (category === 'workshop') {
                throw new Error('git died');
            }
            return '/tpl' as any;
        });

        await expect(updateCmd()).rejects.toThrow(
            'Refreshed 3/4 template caches — 1 update(s) failed.',
        );
        // The failing category is still warned per-category.
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Failed to update workshop template'),
        );
    });

    it('fails when every category fails', async () => {
        vi.mocked(resolveTemplateDir).mockImplementation(() => {
            throw new Error('offline');
        });

        await expect(updateCmd()).rejects.toThrow(
            'Refreshed 0/4 template caches — 4 update(s) failed.',
        );
    });
});
