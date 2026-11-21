import { describe, it, beforeEach, afterEach } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

describe('Not Implemented Commands (E2E)', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should fail fast for watch outside a project directory', async () => {
        const result = await workspace.run('watch');
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'No pzstudio project found.');
    });

    it('should report not implemented for lang command', async () => {
        const result = await workspace.run('lang', ['some_mod', 'en']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'Not implemented yet');
    });
});
