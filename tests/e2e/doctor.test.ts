import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

describe('doctor command (E2E)', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should fail closed with the discovery error outside a project directory', async () => {
        // Embedded path: the mock logger receives the raw error, so the
        // bare problem statement is what appears on stderr. The formatted
        // Problem/Cause/Try rendering is asserted by the real-env suite.
        const result = await workspace.run('doctor');
        workspace.assertFailure(result);
        workspace.assertStderr(result, 'No pzstudio project found.');
    });

    it('should pass a fully healthy project', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: {
                    id: 12345,
                    title: 'Healthy',
                    visibility: 'public',
                    tags: ['Build 42'],
                },
                mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
                excludes: [],
                schemaVersion: 2,
            }),
        );
        workspace.write('workshop/description.txt', 'A description');
        workspace.write('workshop/preview.png', 'png-bytes');
        workspace.write('my_mod/42/mod.info', 'id=my_mod\nname=My Mod');
        workspace.write('my_mod/42/media/lua/shared.lua', '-- lua');
        // The global-config output dir (fake home) must exist so the
        // filesystem module stays quiet.
        fs.mkdirSync(path.join(workspace.fakeHome, 'Zomboid', 'Workshop'), {
            recursive: true,
        });

        const result = await workspace.run('doctor');
        workspace.assertSuccess(result);
        workspace.assertStdout(result, "'Healthy'");
        workspace.assertStdout(result, 'Ready to develop.');
    });

    it('should report a mod missing on disk as an error', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: {
                    ghost: { name: 'Ghost', description: 'not on disk' },
                },
                excludes: [],
            }),
        );

        const result = await workspace.run('doctor');
        workspace.assertFailure(result);
        workspace.assertStdout(result, "Mod folder 'ghost' is declared");
        workspace.assertStdout(result, 'missing on disk');
        workspace.assertStdout(result, 'blocking issues');
        workspace.assertStderr(result, 'Doctor found 1 blocking issues');
    });

    it('should warn about the game build falling outside pzBuildCompatibility without failing', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
                excludes: [],
                pzBuildCompatibility: '42.x',
                schemaVersion: 2,
            }),
        );
        workspace.write('my_mod/42/media/lua/shared.lua', '-- lua');
        workspace.write('workshop/description.txt', 'A description');

        const result = await workspace.run('doctor', [
            '--game-build',
            '43.0.0',
        ]);
        workspace.assertSuccess(result);
        workspace.assertStdout(result, "targets PZ build '42.x'");
        workspace.assertStdout(result, '1 warning(s)');
        // Warnings-only verdict (CLI-7): continue, review advised.
        workspace.assertStdout(result, 'Doctor completed with 1 warnings');
    });
});
