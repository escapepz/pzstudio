import { spawnSync } from 'child_process';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve as resolvePath } from 'path';
import { unzipSync } from 'fflate';
import { log, warn, verbose } from './logger';
import { TemplateResolutionError } from '@pzstudio/core';
import type { TemplateTransport } from '@pzstudio/platform';

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

/* ------------------------------------------------------------------ */
/* URL / ref validation shared by both transports                      */
/* ------------------------------------------------------------------ */

const GIT_URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$'()*+,;=%-]+$/;
const GIT_SHORT_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Normalizes a template url (https URL or user/repo shorthand) to
 * https://github.com/owner/repo and returns the GitHub owner/repo pair.
 */
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

/* ------------------------------------------------------------------ */
/* Git transport (default on Node hosts)                               */
/* ------------------------------------------------------------------ */

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

    download(url: string, ref: string | undefined, destDir: string): void {
        validateRef(ref);
        const { normalizedUrl } = parseGitHubTarget(url);

        log(
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

        log(`- Refreshing template cache at ${cacheDir}...`);
        const git = (args: string[]) =>
            spawnSync('git', args, {
                cwd: cacheDir,
                stdio: 'pipe',
                timeout: GIT_SPAWN_TIMEOUT_MS,
            });

        const ok = (result: ReturnType<typeof spawnSync>, what: string) => {
            if (result.error) {
                warn(
                    `- Failed to run git ${what}: ${result.error.message}${errnoSuffix(result.error)}`,
                );
                return false;
            }
            if (result.status !== 0) {
                warn(
                    `- git ${what} failed (exit ${result.status}).${gitResultError(result)}`,
                );
                return false;
            }
            return true;
        };

        // 1. git fetch --all (include tags so tag-based refs can be refreshed too)
        if (!ok(git(['fetch', '--all', '--tags']), 'fetch')) return false;

        // 2. Reset to the requested ref.
        // Branch refs live under origin/<ref>, but some templates use tags.
        const resetTargets = ref
            ? ref === 'default'
                ? ['origin/HEAD']
                : [`origin/${ref}`, `refs/tags/${ref}`, ref]
            : ['origin/HEAD'];

        let resetSucceeded = false;
        for (const target of resetTargets) {
            if (git(['reset', '--hard', target]).status === 0) {
                if (target !== resetTargets[0]) {
                    log(`  - Refreshed using ${target}.`);
                }
                resetSucceeded = true;
                break;
            }
        }
        if (!resetSucceeded) {
            warn(`- git reset failed: no matching ref for '${ref}'.`);
            return false;
        }

        // 3. git submodule update --init --recursive --force
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

        // 4. git clean -fdx
        return ok(git(['clean', '-fdx']), 'clean');
    }

    isCacheValid(dir: string): boolean {
        return isDirNonEmpty(dir) && existsSync(join(dir, '.git'));
    }
}

/* ------------------------------------------------------------------ */
/* Fetch transport (fallback where git is missing, default for web)    */
/* ------------------------------------------------------------------ */

const FETCH_MANIFEST = '.pzstudio-fetch.json';
const FETCH_TIMEOUT_MS = 120_000;

// Runs in a child process: the CLI is synchronous and Node has no sync
// fetch; this bridge performs the HTTPS download and stores the body.
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

/**
 * Downloads the repository archive through codeload.github.com and extracts
 * it with fflate — no git binary required. The same flow maps cleanly onto
 * a browser host (fetch + JS unzip) for the vscode.dev extension.
 */
export class FetchTransport implements TemplateTransport {
    readonly name = 'fetch' as const;

    download(url: string, ref: string | undefined, destDir: string): void {
        validateRef(ref);
        const { owner, repo } = parseGitHubTarget(url);

        const candidateUrls = this.archiveUrls(owner, repo, ref);
        let lastError: Error | undefined;

        for (const archiveUrl of candidateUrls) {
            try {
                verbose(`- Fetching template archive from ${archiveUrl}...`);
                const zip = this.fetchArchive(archiveUrl);
                log(
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
        // The fetch cache has no git history; refreshing means re-downloading.
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
            warn(
                `Fetch cache at ${cacheDir} has no manifest; cannot refresh (delete it to re-download).`,
            );
            return false;
        }
        rmSync(cacheDir, { recursive: true, force: true });
        try {
            this.download(url, ref, cacheDir);
            return true;
        } catch (err) {
            warn(`- Re-download failed: ${(err as Error).message}`);
            return false;
        }
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
            parts.shift(); // strip top-level archive folder
            const relative = parts.join('/');
            if (!relative || entryPath.endsWith('/')) {
                continue;
            }
            const outPath = resolvePath(root, relative);
            if (!outPath.startsWith(root)) {
                continue; // zip-slip guard
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
    } catch {
        // Manifest is an optimization for refresh(); ignore write failures.
    }
}

/* ------------------------------------------------------------------ */
/* Transport selection                                                 */
/* ------------------------------------------------------------------ */

let activeTransport: TemplateTransport | undefined;

/**
 * Overrides the active transport (used by embedders, e.g. the web extension
 * injecting FetchTransport).
 */
export function setTemplateTransport(
    transport: TemplateTransport | undefined,
): void {
    activeTransport = transport;
}

/**
 * Returns the active transport, or the default for this host: git when the
 * git binary is available, else the HTTPS fetch transport.
 */
export function getTemplateTransport(): TemplateTransport {
    if (activeTransport) {
        return activeTransport;
    }
    return isGitAvailable() ? new GitTransport() : new FetchTransport();
}
