import fs from 'fs';
import os from 'os';
import path from 'path';
import { getFakeHome, setFakeHome } from './fake-home';
import { runCLI } from '../../packages/cli/src/lib/cli';
import { CliUsageError, setCliIO } from '../../packages/cli/src/lib/parser';
import { setLogger, ILogger } from '../../packages/cli/src/lib/logger';
import { createTempDir, deleteDir } from './test-fixtures';

let currentFakeHome: string | undefined;

/**
 * Per-worker scratch copy of the repo-root .template-legacy. Every fake
 * home links to it instead of re-copying the templates per test — the
 * recursive copy + delete around each case dominated CI runtime on the
 * Windows runners. The store is a throwaway copy (never the repo checkout
 * itself), and Node's rmSync unlinks junctions/symlinks instead of
 * descending into them, so cleanup can never reach the store through a
 * linked fake home.
 */
let sharedLegacyStore: string | null | undefined;

function getSharedLegacyStore(): string | null {
    if (sharedLegacyStore !== undefined) return sharedLegacyStore;
    const legacyDir = path.resolve(__dirname, '..', '..', '.template-legacy');
    if (!fs.existsSync(legacyDir) || fs.readdirSync(legacyDir).length === 0) {
        // Mirror the old behavior: without checked-out submodules the
        // fixture seeds nothing.
        sharedLegacyStore = null;
        return sharedLegacyStore;
    }
    const store = fs.mkdtempSync(
        path.join(os.tmpdir(), 'pzstudio-e2e-templates-'),
    );
    fs.cpSync(legacyDir, path.join(store, '.template-legacy'), {
        recursive: true,
    });
    sharedLegacyStore = store;
    process.once('exit', () => {
        try {
            fs.rmSync(store, { recursive: true, force: true });
        } catch {
            // Best effort: OS temp cleanup handles leftovers.
        }
    });
    return sharedLegacyStore;
}

export interface E2EResult {
    stdout: string[];
    stderr: string[];
    exitCode: number;
}

export class E2ETestWorkspace {
    public readonly dir: string;
    public readonly fakeHome: string;
    private readonly originalCwd: string;
    private stdout: string[] = [];
    private stderr: string[] = [];
    private exitCode: number = 0;

    constructor() {
        this.dir = createTempDir();
        this.fakeHome = createTempDir();
        this.originalCwd = process.cwd();

        // One link per fake home (junction on Windows, dir symlink on
        // POSIX); copy as a fallback for filesystems without link support.
        const store = getSharedLegacyStore();
        if (store) {
            const src = path.join(store, '.template-legacy');
            const dest = path.join(
                this.fakeHome,
                '.pzstudio',
                '.template-legacy',
            );
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            try {
                fs.symlinkSync(
                    src,
                    dest,
                    process.platform === 'win32' ? 'junction' : 'dir',
                );
            } catch {
                fs.cpSync(src, dest, { recursive: true });
            }
        }
    }

    /**
     * Runs the CLI in the temporary workspace.
     * @param cmd The command to run (optional)
     * @param args The arguments to pass
     * @returns The result of the execution
     */
    public async run(
        cmd?: string,
        args: string[] = [],
        overrideCwd?: string,
    ): Promise<E2EResult> {
        this.stdout = [];
        this.stderr = [];
        this.exitCode = 0;

        // Mock logger
        const mockLogger: ILogger = {
            log: (msg) => this.stdout.push(msg),
            info: (msg) => this.stdout.push(msg),
            warn: (msg) => this.stderr.push(msg),
            error: (msg) => {
                const errorMsg =
                    msg instanceof Error ? msg.message : String(msg);
                this.stderr.push(errorMsg);
            },
            verbose: (msg) => this.stdout.push(msg),
            clear: () => {},
        };
        setLogger(mockLogger);

        // Parser-level output (version line, usage errors) flows through
        // CliIO, not the logger — capture it into the same buffers.
        setCliIO({
            stdout: (text) => this.stdout.push(text),
            stderr: (text) => this.stderr.push(text),
        });

        // Mock process.exit
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
            this.exitCode = (code as number) ?? 0;
            throw new Error(`Process exited with code ${code}`);
        });

        // Set our fake home via the global mock state
        const previousHome = getFakeHome();
        setFakeHome(this.fakeHome);

        // Mock process.argv for runCLI's internal calls to cmd() and args()
        const originalArgv = process.argv;
        process.argv = ['node', 'pzstudio', ...(cmd ? [cmd] : []), ...args];

        // Change CWD to temp dir or override
        process.chdir(overrideCwd || this.dir);

        try {
            await runCLI(cmd, args);
        } catch (e: any) {
            if (!e.message.startsWith('Process exited with code')) {
                this.stderr.push(e.stack || e.message);
                // Usage errors (unknown command/flag, arity) are exit 2.
                this.exitCode = e instanceof CliUsageError ? 2 : 1;
            }
        } finally {
            // Restore everything
            process.chdir(this.originalCwd);
            process.argv = originalArgv;
            exitSpy.mockRestore();
            setFakeHome(previousHome);
            setLogger(undefined);
            setCliIO(undefined);
        }

        return {
            stdout: this.stdout,
            stderr: this.stderr,
            exitCode: this.exitCode,
        };
    }

    /**
     * Cleans up the temporary workspace and fake home.
     */
    public cleanup(): void {
        deleteDir(this.dir);
        deleteDir(this.fakeHome);
    }

    /**
     * Checks if a file or directory exists in the workspace.
     */
    public exists(relativePath: string): boolean {
        return fs.existsSync(path.join(this.dir, relativePath));
    }

    /**
     * Reads a file from the workspace.
     */
    public read(relativePath: string): string {
        return fs.readFileSync(path.join(this.dir, relativePath), 'utf8');
    }

    /**
     * Writes a file to the workspace.
     */
    public write(relativePath: string, content: string): void {
        const fullPath = path.join(this.dir, relativePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, content, 'utf8');
    }

    /**
     * Writes a global config file to the fake home.
     */
    public writeGlobalConfig(config: any): void {
        const configPath = path.join(this.fakeHome, '.pzstudio', 'config.json');
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
    }

    /**
     * Reads a JSON file from the workspace.
     */
    public readJson(relativePath: string): any {
        return JSON.parse(this.read(relativePath));
    }

    /**
     * Asserts that the execution was successful (exit code 0).
     */
    public assertSuccess(result: E2EResult): void {
        if (result.exitCode !== 0) {
            throw new Error(
                `Expected exit code 0 but got ${result.exitCode}.\nStderr: ${result.stderr.join('\n')}`,
            );
        }
    }

    /**
     * Asserts that the execution failed with a specific exit code.
     */
    public assertFailure(result: E2EResult, expectedCode: number = 1): void {
        if (result.exitCode !== expectedCode) {
            throw new Error(
                `Expected exit code ${expectedCode} but got ${result.exitCode}.\nStdout: ${result.stdout.join('\n')}`,
            );
        }
    }

    /**
     * Asserts that stdout contains a specific string.
     */
    public assertStdout(result: E2EResult, substring: string): void {
        const found = result.stdout.some((line) => line.includes(substring));
        if (!found) {
            throw new Error(
                `Expected stdout to contain "${substring}" but it did not.\nStdout: ${result.stdout.join('\n')}`,
            );
        }
    }

    /**
     * Asserts that stderr contains a specific string.
     */
    public assertStderr(result: E2EResult, substring: string): void {
        const found = result.stderr.some((line) => line.includes(substring));
        if (!found) {
            throw new Error(
                `Expected stderr to contain "${substring}" but it did not.\nStderr: ${result.stderr.join('\n')}`,
            );
        }
    }

    /**
     * Asserts that stdout matches a specific regex.
     */
    public assertStdoutMatch(result: E2EResult, pattern: RegExp): void {
        const found = result.stdout.some((line) => pattern.test(line));
        if (!found) {
            throw new Error(
                `Expected stdout to match ${pattern} but it did not.\nStdout: ${result.stdout.join('\n')}`,
            );
        }
    }

    /**
     * Asserts that stdout does NOT match a specific regex.
     */
    public assertStdoutNotMatch(result: E2EResult, pattern: RegExp): void {
        const found = result.stdout.some((line) => pattern.test(line));
        if (found) {
            throw new Error(
                `Expected stdout NOT to match ${pattern} but it did.\nStdout: ${result.stdout.join('\n')}`,
            );
        }
    }
}

/**
 * Creates a new E2E test workspace.
 */
export function createE2EWorkspace(): E2ETestWorkspace {
    return new E2ETestWorkspace();
}
