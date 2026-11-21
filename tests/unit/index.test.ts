import { describe, it, expect, vi } from 'vitest';
import { runCLI } from '../../packages/cli/src/lib/cli';

vi.mock('../../packages/cli/src/lib/cli', () => ({
    runCLI: vi.fn(() => Promise.resolve()),
}));

describe('Index Entry Point', () => {
    it('should call runCLI when imported', async () => {
        await import('../../packages/cli/src/index');
        expect(runCLI).toHaveBeenCalled();
    });
});
