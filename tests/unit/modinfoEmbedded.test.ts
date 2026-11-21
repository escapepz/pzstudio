import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createTempDir, deleteDir } from '../helpers/test-fixtures';
import { createPzStudio } from '../../packages/cli/src/lib/studio';
import { runCLI } from '../../packages/cli/src/lib/cli';
import { CliError } from '../../packages/cli/src/lib/errors';
import { setLogger } from '../../packages/cli/src/lib/logger';
import {
    setProjectDir,
    setProjectRootAnchor,
} from '../../packages/cli/src/lib/helper';
import { setCliIO, type CliIO } from '../../packages/cli/src/lib/parser';

let tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = createTempDir();
    tempDirs.push(dir);
    return dir;
}

function makeProjectDir(mods: Record<string, unknown>): string {
    const dir = makeTempDir();
    fs.writeFileSync(
        path.join(dir, 'project.json'),
        JSON.stringify({
            workshop: { title: 'Test', visibility: 'public', tags: [] },
            mods,
            excludes: [],
        }),
    );
    return dir;
}

function makeBranchFolder(projectDir: string, modId: string): string {
    const branch = path.join(projectDir, modId, '42', 'media');
    fs.mkdirSync(branch, { recursive: true });
    return path.join(projectDir, modId, '42');
}

afterEach(() => {
    setLogger(undefined);
    setCliIO(undefined);
    setProjectDir(undefined);
    setProjectRootAnchor(undefined);
    for (const dir of tempDirs) deleteDir(dir);
    tempDirs = [];
});

describe('modinfo embedded project-root injection (sweep d08-B5)', () => {
    it('studio.run modinfo generate <modId> with a valid projectDir generates the branch mod.info — cwd is never consulted', async () => {
        const proj = makeProjectDir({
            modA: { name: 'Mod A', description: 'A test mod' },
        });
        const branch = makeBranchFolder(proj, 'modA');
        const studio = createPzStudio();

        await studio.run('modinfo', ['generate', 'modA'], {
            projectDir: proj,
        });

        const modInfoPath = path.join(branch, 'mod.info');
        expect(fs.existsSync(modInfoPath)).toBe(true);
        const content = fs.readFileSync(modInfoPath, 'utf8');
        expect(content).toContain('name=Mod A');
        expect(content).toContain('id=modA');
    });

    it('studio.run modinfo generate (all mods) honors excludes with the injected root', async () => {
        const proj = makeProjectDir({
            modA: { name: 'Mod A', description: 'A test mod' },
            modB: { name: 'Mod B', description: 'Excluded mod' },
        });
        fs.writeFileSync(
            path.join(proj, 'project.json'),
            JSON.stringify({
                workshop: { title: 'Test', visibility: 'public', tags: [] },
                mods: {
                    modA: { name: 'Mod A', description: 'A test mod' },
                    modB: { name: 'Mod B', description: 'Excluded mod' },
                },
                excludes: ['modB'],
            }),
        );
        const branchA = makeBranchFolder(proj, 'modA');
        const branchB = makeBranchFolder(proj, 'modB');
        const studio = createPzStudio();

        await studio.run('modinfo', ['generate'], { projectDir: proj });

        expect(fs.existsSync(path.join(branchA, 'mod.info'))).toBe(true);
        expect(fs.existsSync(path.join(branchB, 'mod.info'))).toBe(false);
    });

    it('no project at all fails closed with the structured error — cause names the searched path', async () => {
        const emptyDir = makeTempDir();
        setLogger({
            log: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            verbose: () => {},
        });
        const captured: Captured = { stdout: [], stderr: [] };
        const sink: CliIO = {
            stdout: (t) => captured.stdout.push(t),
            stderr: (t) => captured.stderr.push(t),
        };
        setCliIO(sink);

        let caught: unknown;
        try {
            await runCLI('modinfo', ['generate'], {
                flags: ['--project', emptyDir],
            });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(CliError);
        const err = caught as CliError;
        expect(err.message).toBe('No pzstudio project found.');
        expect(err.cause).toContain(
            `Searched from '${path.resolve(emptyDir)}'`,
        );
        expect(err.tryHint).toContain('pzstudio new');
    });
});

interface Captured {
    stdout: string[];
    stderr: string[];
}
