/**
 * Sweep d08-B5 regression (P1): the ext `pzstudio.modinfoGenerate` leg runs
 * the `modinfo` command through the v2 embedded lifecycle (studio.run with
 * an explicit projectDir). The command resolved its mod-folder walk from the
 * LEGACY ambient default (legacyProjectDir → the raw anchor slots, never
 * written by embedded hosts) which falls back to the HOST process's cwd —
 * so every embedded run failed with "No pzstudio project found." even
 * though the project was passed in, while the CLI (cwd = project) worked.
 * The command must inject its invocation-resolved project root through the
 * whole generation flow.
 */
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

/** A minimal valid project with the given mods (validated on read). */
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

/** A mod folder with one Build 42 branch folder carrying a media dir. */
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
        // The project lives in a temp dir; the vitest process cwd (repo
        // root) carries no project.json above it — exactly the host-process
        // shape that made the legacy-default walk fail closed.
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
        // Structured, not vague: the error names where discovery searched
        // and what to do next.
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
