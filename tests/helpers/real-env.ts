import { execFile, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { DEFAULT_TEMPLATES } from '@pzstudio/core';

const execFileAsync = promisify(execFile);

/** Absolute path of the built CLI package dist. */
export const CLI_DIST_DIR = path.resolve(
    __dirname,
    '..',
    '..',
    'packages',
    'cli',
    'dist',
);
/** Entry point of the real binary under test. */
export const CLI_BIN = path.join(CLI_DIST_DIR, 'index.js');

/**
 * Seeds the fake home's template cache with the bundled legacy workshop
 * template so template-resolving commands (build, watch) never touch the
 * network: the git transport treats a non-empty directory containing .git
 * as a valid cache, and the legacy snapshot has the same content the official
 * repo had at its pinned ref. `new --offline` needs no seeding — it uses the
 * legacy fallback directly.
 */
export function seedWorkshopTemplateCache(home: string): void {
    const legacyWorkshop = path.join(
        CLI_DIST_DIR,
        '.template-legacy',
        '.template-workshop',
    );
    if (!isDirNonEmpty(legacyWorkshop)) {
        throw new Error(
            'dist/.template-legacy/.template-workshop is empty — build the CLI after checking out the .template-legacy submodules.',
        );
    }
    // Same derivation as the CLI's getCachePathFromUrl on the default
    // template URL.
    const [user, repo] = DEFAULT_TEMPLATES.workshop.url
        .replace('https://github.com/', '')
        .replace('.git', '')
        .split('/');
    const cache = path.join(home, '.pzstudio', 'templates', user, repo);
    fs.cpSync(legacyWorkshop, cache, { recursive: true });
    // The copied snapshot carries the submodule's .git gitlink file; replace
    // it with a real .git directory so the cache probe accepts it.
    fs.rmSync(path.join(cache, '.git'), { force: true, recursive: true });
    fs.mkdirSync(path.join(cache, '.git'), { recursive: true });
}

/** Default workshop output root the CLI derives from HOME. */
export function defaultOutRoot(home: string): string {
    return path.join(home, 'Zomboid', 'Workshop');
}

/**
 * Fails fast with an actionable message when the CLI has not been built.
 * Same contract as the extBundleActivation dist gate.
 */
export function assertCliBuilt(): void {
    if (!fs.existsSync(CLI_BIN)) {
        throw new Error(
            'packages/cli/dist/index.js is missing — build the CLI first (pnpm --filter pzstudio-cli... build).',
        );
    }
}

function isDirNonEmpty(dir: string): boolean {
    try {
        return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

/**
 * Whether template-dependent commands (`new`, `add`) can run offline. The
 * binary bootstraps templates exclusively from the dist copy the build
 * populated from the .template-legacy submodules — the child's cwd is a temp
 * directory, so the repo-root probe never applies to a spawned process.
 */
export function hasLegacyTemplates(): boolean {
    return isDirNonEmpty(path.join(CLI_DIST_DIR, '.template-legacy'));
}

export interface RealEnvResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface RunPzOptions {
    /** Working directory for the command. */
    cwd: string;
    /** Real HOME/USERPROFILE the child process sees. */
    home: string;
    /** Hard kill timeout in ms (default 30s). */
    timeout?: number;
}

/**
 * Runs the real CLI binary as a child process — no in-process mocks. Exit
 * code and captured stdout/stderr are the genuine terminal behavior of the
 * built artifact.
 */
export async function runPz(
    args: string[],
    options: RunPzOptions,
): Promise<RealEnvResult> {
    assertCliBuilt();
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: options.home,
        USERPROFILE: options.home,
    };
    try {
        const { stdout, stderr } = await execFileAsync(
            process.execPath,
            [CLI_BIN, ...args],
            {
                cwd: options.cwd,
                env,
                timeout: options.timeout ?? 30000,
                killSignal: 'SIGKILL',
                encoding: 'utf8',
                windowsHide: true,
                maxBuffer: 16 * 1024 * 1024,
            },
        );
        return { stdout, stderr, exitCode: 0 };
    } catch (err) {
        const e = err as NodeJS.ExecFileException & {
            stdout?: string;
            stderr?: string;
        };
        if (typeof e.code === 'number') {
            // Non-zero exit: a legitimate CLI result.
            return {
                stdout: e.stdout ?? '',
                stderr: e.stderr ?? '',
                exitCode: e.code,
            };
        }
        // Spawn itself failed (ENOENT, timeout kill): harness failure.
        throw err;
    }
}

export interface SpawnedCli {
    child: ChildProcess;
    getStdout(): string;
    getStderr(): string;
    /** Resolves with the real exit info when the process ends. */
    exit: Promise<{ code: number | null; signal: string | null }>;
    /** Polls until predicate matches accumulated output or the timeout hits. */
    waitFor(
        predicate: (output: { stdout: string; stderr: string }) => boolean,
        timeoutMs: number,
        message: string,
    ): Promise<void>;
    /** Force-kills the process and waits for its exit. */
    stop(): Promise<{ code: number | null; signal: string | null }>;
}

/**
 * Spawns a long-running CLI command (e.g. `watch`) with piped output for
 * polling. Cleanup relies on SIGKILL because the watcher holds native handles.
 */
export function spawnPz(args: string[], options: RunPzOptions): SpawnedCli {
    assertCliBuilt();
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: options.home,
        USERPROFILE: options.home,
    };
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
        cwd: options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
    });

    const exit = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => resolve({ code, signal }));
        },
    );

    const dumpOutput = () =>
        `\n--- captured stdout ---\n${stdout || '(empty)'}\n--- captured stderr ---\n${stderr || '(empty)'}`;

    return {
        child,
        getStdout: () => stdout,
        getStderr: () => stderr,
        exit,
        async waitFor(predicate, timeoutMs, message) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (predicate({ stdout, stderr })) return;
                if (child.exitCode !== null || child.signalCode !== null) {
                    throw new Error(
                        `CLI exited (code=${child.exitCode}, signal=${child.signalCode}) before the condition matched: ${message}.${dumpOutput()}`,
                    );
                }
                await sleep(100);
            }
            throw new Error(
                `Timed out after ${timeoutMs}ms waiting for: ${message}.${dumpOutput()}`,
            );
        },
        async stop() {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
            }
            return exit;
        },
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Temp workspace for real-environment tests: a working directory for the
 * commands plus a fake home the child process sees as HOME/USERPROFILE, so
 * `~/.pzstudio` and the workshop output never touch the real machine.
 */
export class RealEnvWorkspace {
    readonly dir: string;
    readonly home: string;

    constructor() {
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pzstudio-realcwd-'));
        this.home = fs.mkdtempSync(
            path.join(os.tmpdir(), 'pzstudio-realhome-'),
        );
    }

    /** Absolute path under the workspace dir. */
    path(relative = ''): string {
        return path.join(this.dir, relative);
    }

    /** Absolute path under the fake home dir. */
    homePath(relative = ''): string {
        return path.join(this.home, relative);
    }

    write(relative: string, content: string): void {
        const full = path.join(this.dir, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
    }

    writeHome(relative: string, content: string): void {
        const full = path.join(this.home, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
    }

    exists(relative: string, base: 'dir' | 'home' = 'dir'): boolean {
        const full =
            base === 'dir'
                ? path.join(this.dir, relative)
                : path.join(this.home, relative);
        return fs.existsSync(full);
    }

    read(relative: string, base: 'dir' | 'home' = 'dir'): string {
        const full =
            base === 'dir'
                ? path.join(this.dir, relative)
                : path.join(this.home, relative);
        return fs.readFileSync(full, 'utf8');
    }

    readJson(relative: string, base: 'dir' | 'home' = 'dir'): any {
        return JSON.parse(this.read(relative, base));
    }

    run(
        args: string[],
        opts: Partial<RunPzOptions> = {},
    ): Promise<RealEnvResult> {
        return runPz(args, { cwd: this.dir, home: this.home, ...opts });
    }

    async cleanup(): Promise<void> {
        await removeDirWithRetry(this.dir);
        await removeDirWithRetry(this.home);
    }
}

/**
 * Removal with retries: killed watchers may leave briefly-locked handles on
 * Windows (same recovery pattern as the CLI's own removeDirRecursive).
 */
async function removeDirWithRetry(dir: string, attempts = 10): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (err) {
            if (attempt >= attempts) throw err;
            await sleep(300);
        }
    }
}

/** Polls a filesystem condition until it holds or the timeout hits. */
export async function waitForCondition(
    condition: () => boolean,
    timeoutMs: number,
    message: string,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return;
        await sleep(100);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${message}`);
}
