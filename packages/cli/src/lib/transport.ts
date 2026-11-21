import { spawnSync } from 'child_process';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve as resolvePath } from 'path';
import { unzipSync } from 'fflate';
import { emitInfo, emitVerbose, emitWarn } from './logger';
import { TemplateResolutionError } from '@pzstudio/core';
import type { TemplateTransport } from '@pzstudio/platform';
import { getActiveInvocationContext, type IoScope } from './invocation';

export type { TemplateTransport };

function isDirNonEmpty(dir: string): boolean {
    if (!existsSync(dir)) return false;
    try {
        if (!readdirSync(dir).length) return false;
    } catch {
        return false;
    }
    return true;
}

const GIT_URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$'()*+,;=%-]+$/;
const GIT_SHORT_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/;

export function parseGitHubTarget(url: string): {
    normalizedUrl: string;
    owner: string;
    repo: string;
} {
    if (GIT_SHORT_RE.test(url)) {
        return {
            normalizedUrl: `https://github.com/${url}.git`,
            owner: url.split('/')[0],
            repo: url.split('/')[1],
        };
    }
    if (!GIT_URL_RE.test(url)) {
        throw new TemplateResolutionError(
            `Invalid template url '${url}': expected an https URL or user/repo shorthand.`,
        );
    }
    const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)/);
    if (!match) {
        throw new TemplateResolutionError(
            `Invalid template url '${url}': only github.com repositories are supported.`,
        );
    }
    return {
        normalizedUrl: url,
        owner: match[1],
        repo: match[2],
    };
}

function validateRef(ref?: string): void {
    if (ref && ref !== 'default' && !GIT_REF_RE.test(ref)) {
        throw new TemplateResolutionError(
            `Invalid template ref '${ref}': only letters, digits, '.', '_', '-' and '/' are allowed.`,
        );
    }
}

export class TemplateCloneError extends TemplateResolutionError {
    constructor(
        message: string,
        public readonly cause?: any,
    ) {
        super(message);
        this.name = 'TemplateCloneError';
    }
}

const GIT_SPAWN_TIMEOUT_MS = 120_000;

function gitResultError(result: { stderr?: string | Buffer }): string {
    const stderr =
        typeof result.stderr === 'string'
            ? result.stderr
            : (result.stderr?.toString('utf8') ?? '');
    const trimmed = stderr.trim();
    return trimmed ? `\n${trimmed}` : '';
}

function errnoSuffix(error: NodeJS.ErrnoException): string {
    return error.code === 'ETIMEDOUT' ? ' (timed out)' : '';
}

function isGitAvailable(): boolean {
    const result = spawnSync('git', ['--version'], {
        stdio: 'pipe',
        timeout: 10_000,
    });
    return !result.error && result.status === 0;
}

export class GitTransport implements TemplateTransport {
    readonly name = 'git' as const;

    constructor(private readonly io?: IoScope | undefined) {}

    download(url: string, ref: string | undefined, destDir: string): void {
        validateRef(ref);
        const { normalizedUrl } = parseGitHubTarget(url);

        emitInfo(
            this.io,
            `- Cloning template from ${normalizedUrl}${ref ? ` (ref: ${ref})` : ''}...`,
        );

        const args = [
            'clone',
            '--depth',
            '1',
            '--recurse-submodules',
            '--shallow-submodules',
        ];
        if (ref && ref !== 'default') {
            args.push('-b', ref);
        }
        args.push(normalizedUrl, destDir);

        const result = spawnSync('git', args, {
            stdio: 'pipe',
            timeout: GIT_SPAWN_TIMEOUT_MS,
        });
        if (result.error) {
            throw new TemplateCloneError(
                `git clone failed: ${result.error.message}${errnoSuffix(result.error)}`,
                result.error,
            );
        }
        if (result.status !== 0) {
            throw new TemplateCloneError(
                `git clone failed (exit ${result.status}).${gitResultError(result)}`,
            );
        }
    }

    refresh(cacheDir: string, ref: string | undefined): boolean {
        validateRef(ref);

        emitInfo(this.io, `- Refreshing template cache at ${cacheDir}...`);
        const git = (args: string[]) =>
            spawnSync('git', args, {
                cwd: cacheDir,
                stdio: 'pipe',
                timeout: GIT_SPAWN_TIMEOUT_MS,
            });

        const ok = (result: ReturnType<typeof spawnSync>, what: string) => {
            if (result.error) {
                emitWarn(
                    this.io,
                    `- Failed to run git ${what}: ${result.error.message}${errnoSuffix(result.error)}`,
                );
                return false;
            }
            if (result.status !== 0) {
                emitWarn(
                    this.io,
                    `- git ${what} failed (exit ${result.status}).${gitResultError(result)}`,
                );
                return false;
            }
            return true;
        };

        if (!ok(git(['fetch', '--all', '--tags']), 'fetch')) return false;

        const resetTargets = ref
            ? ref === 'default'
                ? ['origin/HEAD']
                : [`origin/${ref}`, `refs/tags/${ref}`, ref]
            : ['origin/HEAD'];

        let resetSucceeded = false;
        for (const target of resetTargets) {
            if (git(['reset', '--hard', target]).status === 0) {
                if (target !== resetTargets[0]) {
                    emitInfo(this.io, `  - Refreshed using ${target}.`);
                }
                resetSucceeded = true;
                break;
            }
        }
        if (!resetSucceeded) {
            emitWarn(
                this.io,
                `- git reset failed: no matching ref for '${ref}'.`,
            );
            return false;
        }

        if (
            !ok(
                git([
                    'submodule',
                    'update',
                    '--init',
                    '--recursive',
                    '--force',
                ]),
                'submodule update',
            )
        )
            return false;

        return ok(git(['clean', '-fdx']), 'clean');
    }

    isCacheValid(dir: string): boolean {
        return isDirNonEmpty(dir) && existsSync(join(dir, '.git'));
    }
}

const FETCH_MANIFEST = '.pzstudio-fetch.json';
const FETCH_TIMEOUT_MS = 120_000;

const FETCH_SCRIPT = `
const [url, out] = process.argv.slice(1);
fetch(url, { signal: AbortSignal.timeout(${FETCH_TIMEOUT_MS}) })
    .then((res) => {
        if (!res.ok) {
            console.error('HTTP ' + res.status + ' for ' + url);
            process.exit(1);
        }
        return res.arrayBuffer();
    })
    .then((buf) => {
        require('fs').writeFileSync(out, Buffer.from(buf));
    })
    .catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
`;

export class FetchTransport implements TemplateTransport {
    readonly name = 'fetch' as const;

    constructor(private readonly io?: IoScope | undefined) {}

    download(url: string, ref: string | undefined, destDir: string): void {
        validateRef(ref);
        const { owner, repo } = parseGitHubTarget(url);

        const candidateUrls = this.archiveUrls(owner, repo, ref);
        let lastError: Error | undefined;

        for (const archiveUrl of candidateUrls) {
            try {
                emitVerbose(
                    this.io,
                    `- Fetching template archive from ${archiveUrl}...`,
                );
                const zip = this.fetchArchive(archiveUrl);
                emitInfo(
                    this.io,
                    `- Downloaded template ${owner}/${repo}${ref ? ` (ref: ${ref})` : ''}.`,
                );
                this.extract(zip, destDir);
                writeManifest(destDir, url);
                return;
            } catch (err) {
                lastError = err as Error;
            }
        }

        throw new TemplateCloneError(
            `Failed to download template ${owner}/${repo}: ${lastError?.message ?? 'unknown error'}`,
            lastError,
        );
    }

    refresh(cacheDir: string, ref: string | undefined): boolean {
        const manifestPath = join(cacheDir, FETCH_MANIFEST);
        let url: string | undefined;
        try {
            if (existsSync(manifestPath)) {
                url = JSON.parse(readFileSync(manifestPath, 'utf8')).url;
            }
        } catch {
            url = undefined;
        }
        if (!url) {
            emitWarn(
                this.io,
                `Fetch cache at ${cacheDir} has no manifest; cannot refresh (delete it to re-download).`,
            );
            return false;
        }
        const stagingDir = `${cacheDir}.replacing`;
        rmSync(stagingDir, { recursive: true, force: true });
        try {
            this.download(url, ref, stagingDir);
        } catch (err) {
            rmSync(stagingDir, { recursive: true, force: true });
            emitWarn(
                this.io,
                `- Re-download failed: ${(err as Error).message} — the previous cache at ${cacheDir} was left untouched.`,
            );
            return false;
        }
        rmSync(cacheDir, { recursive: true, force: true });
        renameSync(stagingDir, cacheDir);
        return true;
    }

    isCacheValid(dir: string): boolean {
        return isDirNonEmpty(dir);
    }

    private archiveUrls(owner: string, repo: string, ref?: string): string[] {
        const base = `https://codeload.github.com/${owner}/${repo}/zip`;
        if (!ref || ref === 'default') {
            return [`${base}/HEAD`];
        }
        // Branch first, then tag — codeload returns 404 for the wrong kind.
        return [`${base}/refs/heads/${ref}`, `${base}/refs/tags/${ref}`];
    }

    private fetchArchive(archiveUrl: string): Uint8Array {
        const tmpFile = join(
            tmpdir(),
            `pzstudio-template-${process.pid}-${Date.now()}.zip`,
        );
        const result = spawnSync(
            process.execPath,
            ['-e', FETCH_SCRIPT, archiveUrl, tmpFile],
            { stdio: 'pipe', timeout: FETCH_TIMEOUT_MS + 10_000 },
        );

        const readTempOrThrow = (): Uint8Array => {
            if (!existsSync(tmpFile)) {
                const stderr = gitResultError(result);
                throw new TemplateCloneError(
                    result.error
                        ? `Download failed: ${result.error.message}${errnoSuffix(result.error)}`
                        : `Download failed (exit ${result.status}).${stderr}`,
                );
            }
            return new Uint8Array(readFileSync(tmpFile));
        };
        try {
            return readTempOrThrow();
        } finally {
            rmSync(tmpFile, { force: true });
        }
    }

    private extract(zip: Uint8Array, destDir: string): void {
        const entries = unzipSync(zip);
        // GitHub archives wrap everything in a single <repo>-<sha>/ folder;
        // strip the first path segment so files land directly in destDir.
        mkdirSync(destDir, { recursive: true });
        const root = resolvePath(destDir);
        for (const [entryPath, data] of Object.entries(entries)) {
            const parts = entryPath.replace(/\\/g, '/').split('/');
            parts.shift();
            const relative = parts.join('/');
            if (!relative || entryPath.endsWith('/')) {
                continue;
            }
            const outPath = resolvePath(root, relative);
            if (!outPath.startsWith(root)) {
                continue;
            }
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, data);
        }
    }
}

function writeManifest(destDir: string, url: string): void {
    try {
        writeFileSync(
            join(destDir, FETCH_MANIFEST),
            JSON.stringify(
                { url, fetchedAt: new Date().toISOString() },
                null,
                4,
            ),
            'utf8',
        );
    } catch {}
}

let activeTransport: TemplateTransport | undefined;

export function setTemplateTransport(
    transport: TemplateTransport | undefined,
): void {
    activeTransport = transport;
}

class LazyHostDefaultTransport implements TemplateTransport {
    constructor(private readonly io?: IoScope | undefined) {}

    get name(): 'git' | 'fetch' {
        return resolveHostDefaultTransport(this.io).name;
    }

    download(url: string, ref: string | undefined, destDir: string): void {
        resolveHostDefaultTransport(this.io).download(url, ref, destDir);
    }

    refresh(cacheDir: string, ref: string | undefined): boolean {
        return resolveHostDefaultTransport(this.io).refresh(cacheDir, ref);
    }

    isCacheValid(dir: string): boolean {
        return resolveHostDefaultTransport(this.io).isCacheValid(dir);
    }
}

function resolveHostDefaultTransport(
    io?: IoScope | undefined,
): GitTransport | FetchTransport {
    return isGitAvailable() ? new GitTransport(io) : new FetchTransport(io);
}

export function hostDefaultTransport(
    io?: IoScope | undefined,
): TemplateTransport {
    return new LazyHostDefaultTransport(io);
}

export function legacyTransport(): TemplateTransport {
    return activeTransport ?? hostDefaultTransport();
}

export function getTemplateTransport(): TemplateTransport {
    const ctx = getActiveInvocationContext();
    if (ctx) {
        return ctx.templateTransport;
    }
    return legacyTransport();
}
