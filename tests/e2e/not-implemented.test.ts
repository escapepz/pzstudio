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
        // No project.json: watch cannot start and must exit instead of
        // running forever. A started watch session is long-lived and covered
        // by the unit tests of the sync engine + watch helpers.
        const result = await workspace.run('watch');
        workspace.assertFailure(result);
        workspace.assertStderr(
            result,
            'You must execute this command within a project directory!',
        );
    });

    it('should report not implemented for lang command', async () => {
        const result = await workspace.run('lang', ['en']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'Not implemented yet');
    });
});
