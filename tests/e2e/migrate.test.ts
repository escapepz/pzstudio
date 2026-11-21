import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createE2EWorkspace, E2ETestWorkspace } from '../helpers/e2e-fixtures';

describe('migrate command e2e', () => {
    let workspace: E2ETestWorkspace;

    beforeEach(() => {
        workspace = createE2EWorkspace();
    });

    afterEach(() => {
        workspace.cleanup();
    });

    it('should migrate legacy project.json', async () => {
        const legacyProject = {
            id: 'legacy_id',
            title: 'Legacy Title',
            authors: ['Author1'],
            workshop: {
                visibility: 'public',
                tags: ['Building'],
                excludes: ['temp'],
            },
            mods: {
                my_mod: {
                    name: 'My Mod',
                    description: 'Desc',
                },
            },
        };
        workspace.write('project.json', JSON.stringify(legacyProject));

        const result = await workspace.run('migrate');

        try {
            workspace.assertSuccess(result);
            workspace.assertStderr(result, 'Migrating project.json');
            workspace.assertStderr(
                result,
                'project.json upgraded and synced successfully',
            );

            const upgraded = workspace.readJson('project.json');

            expect(upgraded.id).toBeUndefined();
            expect(upgraded.title).toBeUndefined();
            expect(upgraded.authors).toBeUndefined();

            expect(upgraded.workshop.id).toBe('legacy_id');
            expect(upgraded.workshop.title).toBe('Legacy Title');

            expect(upgraded.workshop.excludes).toBeUndefined();
            expect(upgraded.excludes).toContain('temp');

            expect(upgraded.mods.my_mod.build?.modInfo).toBeUndefined();
        } catch (e) {
            console.log('STDOUT:', result.stdout.join('\n'));
            console.log('STDERR:', result.stderr.join('\n'));
            throw e;
        }
    });

    it('should migrate legacy config.json', async () => {
        const legacyConfig = {
            outdir: 'some/path',
        };
        const configPath = path.join(
            workspace.fakeHome,
            '.pzstudio',
            'config.json',
        );
        if (!fs.existsSync(path.dirname(configPath))) {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(legacyConfig), 'utf8');

        const result = await workspace.run('migrate');

        try {
            workspace.assertSuccess(result);
            workspace.assertStderr(result, 'Migrating config.json');

            const upgraded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            expect(upgraded.useSymlinks).toBe(true);
            expect(upgraded.outdir).toBe('some/path');
        } catch (e) {
            console.log('STDOUT:', result.stdout.join('\n'));
            console.log('STDERR:', result.stderr.join('\n'));
            throw e;
        }
    });

    it('should report if no project.json is found', async () => {
        const result = await workspace.run('migrate');
        workspace.assertSuccess(result);
        workspace.assertStdout(result, 'No project.json found');
    });

    it('should report if files are already up to date', async () => {
        workspace.write(
            'project.json',
            JSON.stringify({
                workshop: { title: 'T', visibility: 'public', tags: [] },
                mods: {
                    m: {
                        name: 'N',
                        description: 'D',
                        build: { modInfo: 'skip' },
                    },
                },
                excludes: [],
            }),
        );

        const result = await workspace.run('migrate');
        workspace.assertSuccess(result);
        workspace.assertStdout(result, 'project.json is already up to date');
    });

    it('should fail cleanly when project.json contains malformed JSON', async () => {
        workspace.write('project.json', '{ invalid json ]]]');

        const result = await workspace.run('migrate');
        workspace.assertFailure(result, 1);

        const hasJsonError = result.stderr.some(
            (line) =>
                line.includes('JSON') ||
                line.includes('Unexpected token') ||
                line.includes('parse'),
        );
        expect(hasJsonError).toBe(true);
    });

    it('should fail cleanly when config.json contains malformed JSON', async () => {
        const configPath = path.join(
            workspace.fakeHome,
            '.pzstudio',
            'config.json',
        );
        if (!fs.existsSync(path.dirname(configPath))) {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
        }
        fs.writeFileSync(configPath, '{ not valid json !!!', 'utf8');

        const result = await workspace.run('migrate');
        workspace.assertFailure(result, 1);

        const hasJsonError = result.stderr.some(
            (line) =>
                line.includes('JSON') ||
                line.includes('Unexpected token') ||
                line.includes('parse'),
        );
        expect(hasJsonError).toBe(true);
    });

    it('should treat an empty config.json as missing keys', async () => {
        const configPath = path.join(
            workspace.fakeHome,
            '.pzstudio',
            'config.json',
        );
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '', 'utf8');

        const result = await workspace.run('migrate');

        workspace.assertSuccess(result);
        workspace.assertStderr(result, 'Migrating config.json');

        const upgraded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(upgraded.useSymlinks).toBe(true);
        expect(upgraded.templates).toBeDefined();
        expect(upgraded.outdir).toBeDefined();
    });

    it('should fail cleanly when project.json is an empty file', async () => {
        workspace.write('project.json', '');

        const result = await workspace.run('migrate');
        workspace.assertFailure(result, 1);

        const hasError = result.stderr.some(
            (line) =>
                line.includes('JSON') ||
                line.includes('Unexpected') ||
                line.includes('parse'),
        );
        expect(hasError).toBe(true);
    });

    it('should fail cleanly when config.json is truncated JSON', async () => {
        const configPath = path.join(
            workspace.fakeHome,
            '.pzstudio',
            'config.json',
        );
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '{"outdir": "some/pa', 'utf8');

        const result = await workspace.run('migrate');
        workspace.assertFailure(result, 1);

        const hasError = result.stderr.some(
            (line) =>
                line.includes('JSON') ||
                line.includes('Unexpected') ||
                line.includes('parse') ||
                line.includes('end of JSON'),
        );
        expect(hasError).toBe(true);
    });

    it('should fail cleanly when both config.json and project.json are corrupt', async () => {
        const configPath = path.join(
            workspace.fakeHome,
            '.pzstudio',
            'config.json',
        );
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '<<<invalid>>>', 'utf8');

        workspace.write('project.json', '[[[not an object]]]');

        const result = await workspace.run('migrate');
        workspace.assertFailure(result, 1);

        const hasError = result.stderr.some(
            (line) =>
                line.includes('JSON') ||
                line.includes('Unexpected') ||
                line.includes('parse'),
        );
        expect(hasError).toBe(true);
    });
});
