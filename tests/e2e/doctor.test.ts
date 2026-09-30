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

    it('prints a parseable envelope with status ok for a healthy project (--json, CLI-8)', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'P', visibility: 'public', tags: [] },
                mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
                excludes: [],
                schemaVersion: 2,
            }),
        );
        workspace.write('workshop/description.txt', 'A description');
        workspace.write('my_mod/42/mod.info', 'id=my_mod\nname=My Mod');
        workspace.write('my_mod/42/media/lua/shared.lua', '-- lua');
        fs.mkdirSync(path.join(workspace.fakeHome, 'Zomboid', 'Workshop'), {
            recursive: true,
        });

        const result = await workspace.run('doctor', ['--json']);
        workspace.assertSuccess(result);

        const envelope = JSON.parse(result.stdout.join('\n'));
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.command).toBe('doctor');
        // status 'ok' means no errors and no warnings; plain infos (e.g.
        // uncached templates, missing preview.png) are allowed.
        expect(envelope.result.status).toBe('ok');
        expect(envelope.result.counts.errors).toBe(0);
        expect(envelope.result.counts.warnings).toBe(0);
        for (const diagnostic of envelope.result.diagnostics) {
            expect(diagnostic.severity).toBe('info');
        }
    });

    it('prints the envelope, marks status error and exits 1 on blocking issues (--json, CLI-8)', async () => {
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

        const result = await workspace.run('doctor', ['--json']);
        workspace.assertFailure(result);

        const envelope = JSON.parse(result.stdout.join('\n'));
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.command).toBe('doctor');
        expect(envelope.result.status).toBe('error');
        expect(envelope.result.counts.errors).toBeGreaterThan(0);
        // The envelope carries the typed finding among the diagnostics.
        const errorDiagnostic = envelope.result.diagnostics.find(
            (d: any) => d.severity === 'error',
        );
        expect(errorDiagnostic).toMatchObject({
            severity: 'error',
            module: expect.any(String),
            code: expect.any(String),
            message: expect.any(String),
        });
    });
});
