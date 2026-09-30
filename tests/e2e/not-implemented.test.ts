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
        workspace.assertStderr(result, 'No pzstudio project found.');
    });

    it('should report not implemented for lang command', async () => {
        // lang takes <modId> <lang>: pass both so the invocation reaches the
        // (still registered, hidden) stub instead of a usage error.
        const result = await workspace.run('lang', ['some_mod', 'en']);
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'Not implemented yet');
    });
});
