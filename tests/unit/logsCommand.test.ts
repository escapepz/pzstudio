import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { join } from 'path';
import '../../packages/cli/src/lib/commands/logs';
import { runCLI } from '../../packages/cli/src/lib/cli';
import { setLogger } from '../../packages/cli/src/lib/logger';
import { setCliIO } from '../../packages/cli/src/lib/parser';
import { CliError } from '../../packages/cli/src/lib/errors';
import { setProjectRootAnchor } from '../../packages/cli/src/lib/helper';
import {
    analyzeGameLogFile,
    buildProjectContext,
} from '../../packages/cli/src/lib/consoleLogHost';

const fakeHome = (): string =>
    (globalThis as any).__PZSTUDIO_FAKE_HOME as string;
const defaultLogPath = (): string => join(fakeHome(), 'Zomboid', 'console.txt');

const SESSION_START_LINE = 'LOG  : General      f:0> 15-11-2026 13:28:36';
const LOADING_ZUL_TEST = 'LOG  : Mod          f:0> loading zul_test_dev';
const REFUSING_EXAMPLEMOD =
    'LOG  : Mod          f:0> refusing to list examplemod';
const JUL_HEADER_LINE =
    'Nov 15, 2026 1:30:13 PM zombie.Lua.LuaManager RunLuaInternal]';
const SEVERE_ZUL_PATH =
    'SEVERE: Error found in LUA file: C:/Users/<user>/Zomboid/Workshop/ZUL - Zomboid Unified Logging - dev_branch/Contents/mods/zul_test_dev/42/media/lua/client/zul_test_client.lua';
const ERROR_BLOCK = [
    'ERROR: General      f:0> LuaManager.RunLuaInternal> Exception thrown',
    "\tse.krka.kahlua.vm.KahluaException: zul_test_client.lua:43: '}' expected (to close '{' at line 40) near `require` at Lua.zul_test_client.lua(zul_test_client.lua:43).",
    '\tStack trace:',
    '\t\tLua.zul_test_client.lua(zul_test_client.lua:43)',
    '\t\torg.luaj.kahluafork.compiler.LexState.lexerror(LexState.java:274)',
    '\t\t...',
    '\t\tzombie.Lua.LuaManager.RunLuaInternal(LuaManager.java:1373)',
];
const GAME_EXITED_LINE = 'LOG  : General      f:3979> GameThread exited.';

const ERROR_SESSION = [
    SESSION_START_LINE,
    LOADING_ZUL_TEST,
    REFUSING_EXAMPLEMOD,
    JUL_HEADER_LINE,
    SEVERE_ZUL_PATH,
    ...ERROR_BLOCK,
    GAME_EXITED_LINE,
];

const DEBUG_SESSION = [
    'DEBUG: Animation    f:0 at AnimationSet.Load                   > Loading AnimSet: Base',
    'DEBUG: Animation    f:0 at AnimationSet.Load                   > Loading AnimSet: Base',
    'DEBUG: Animation    f:0 at AnimationSet.Load                   > Loading AnimSet: Base',
    'WARN : General      f:0 at LoadComponentInfo                   > Could not find icon: Build_AnvilStone, script = Stone Anvil',
    GAME_EXITED_LINE,
];

function seedLog(lines: string[]): string {
    const dir = join(fakeHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const logPath = join(dir, 'console.txt');
    fs.writeFileSync(logPath, lines.join('\n'), 'utf-8');
    return logPath;
}

function seedProject(): string {
    const projectPath = join(fakeHome(), 'project');
    fs.mkdirSync(
        join(projectPath, 'zul_test_dev', '42', 'media', 'lua', 'client'),
        {
            recursive: true,
        },
    );
    fs.writeFileSync(
        join(projectPath, 'project.json'),
        JSON.stringify({
            workshop: { title: 'Test Project', visibility: 'public', tags: [] },
            mods: {
                zul_test_dev: { name: 'ZUL Test', description: 'test mod' },
            },
            excludes: [],
            schemaVersion: 2,
        }),
        'utf-8',
    );
    fs.writeFileSync(
        join(
            projectPath,
            'zul_test_dev',
            '42',
            'media',
            'lua',
            'client',
            'zul_test_client.lua',
        ),
        '-- zul test mod\n',
        'utf-8',
    );
    return projectPath;
}

interface LogCall {
    method: string;
    message: any;
}

let logCalls: LogCall[] = [];
let ioStderr: string[] = [];

beforeEach(() => {
    const logger = {
        log: (m: any) => logCalls.push({ method: 'log', message: m }),
        info: (m: any) => logCalls.push({ method: 'info', message: m }),
        warn: (m: any) => logCalls.push({ method: 'warn', message: m }),
        error: (e: any) => logCalls.push({ method: 'error', message: e }),
        verbose: (m: any) => logCalls.push({ method: 'verbose', message: m }),
    };
    setLogger(logger);
    ioStderr = [];
    setCliIO({
        stdout: () => {},
        stderr: (t: string) => ioStderr.push(t),
    });
});

afterEach(() => {
    setLogger(undefined);
    setCliIO(undefined);
    setProjectRootAnchor(undefined);
    logCalls = [];
    ioStderr = [];
});

const loggedData = (): string =>
    logCalls
        .filter((c) => c.method === 'log')
        .map((c) => String(c.message))
        .join('\n');

const errorData = (): string =>
    logCalls
        .filter((c) => c.method !== 'log' && c.method !== 'verbose')
        .map((c) => {
            const m = c.message;
            return String(m instanceof Error ? m.message : m);
        })
        .join('\n');

const jsonEnvelopes = (): any[] =>
    logCalls
        .filter((c) => c.method === 'log')
        .map((c) => String(c.message))
        .filter((t) => t.trim().startsWith('{'))
        .map((t) => JSON.parse(t));

async function runLogs(args: string[]): Promise<unknown> {
    try {
        await runCLI('logs', args, { flags: [] });
        return undefined;
    } catch (e) {
        return e;
    }
}

describe('pzstudio logs command', () => {
    it('1. human mode: session-2 findings attributed to the open project, exit 1', async () => {
        const projectPath = seedProject();
        const logPath = seedLog(ERROR_SESSION);

        const caught = await runLogs([
            '--log',
            logPath,
            '--project',
            projectPath,
        ]);

        expect(caught).toBeInstanceOf(CliError);
        const out = loggedData();
        expect(out).toContain('[lua-syntax-error]');
        expect(out).toContain(
            "'}' expected (to close '{' at line 40) near `require`",
        );
        expect(out).toContain('[mod: zul_test_dev]');
        expect(out).toContain('zul_test_client.lua:43');
        expect(out).toContain('[mod-rejected] refusing to list examplemod');
        expect(out).toContain('Summary: 3 error(s), 0 warning(s), 0 info(s).');
        expect(out).toContain('✗');
    });

    it('2. --json: exactly one envelope, status error, exit 1, stderr clean of report lines', async () => {
        const projectPath = seedProject();
        const logPath = seedLog(ERROR_SESSION);

        const caught = await runLogs([
            '--log',
            logPath,
            '--project',
            projectPath,
            '--json',
        ]);

        expect(caught).toBeInstanceOf(CliError);

        const envelopes = jsonEnvelopes();
        expect(envelopes).toHaveLength(1);
        const envelope = envelopes[0];
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.command).toBe('logs');
        expect(envelope.result.status).toBe('error');
        expect(envelope.result.log).toMatchObject({
            path: logPath,
            sessionStart: '15-11-2026 13:28:36',
            gameExited: true,
            totalLines: ERROR_SESSION.length,
        });
        expect(envelope.result.session.loadedModIds).toContain('zul_test_dev');
        expect(envelope.result.session.rejectedModIds).toEqual(['examplemod']);
        const syntax = envelope.result.findings.find(
            (f: any) => f.category === 'lua-syntax-error',
        );
        expect(syntax).toMatchObject({
            severity: 'error',
            modId: 'zul_test_dev',
            line: 43,
        });
        expect(
            envelope.result.findings.some(
                (f: any) => f.category === 'mod-rejected',
            ),
        ).toBe(true);

        const stderrText = ioStderr.join('') + errorData();
        expect(stderrText).not.toContain('refusing to list examplemod');
        expect(stderrText).not.toContain('[lua-syntax-error]');
        expect(stderrText).not.toContain('[mod-rejected]');
    });

    it('3. --json unreadable log: readError envelope, status error, exit 1, no throw trace on stdout', async () => {
        const missingPath = join(fakeHome(), 'no-such-dir', 'console.txt');

        const caught = await runLogs(['--log', missingPath, '--json']);

        expect(caught).toBeInstanceOf(CliError);
        const envelopes = jsonEnvelopes();
        expect(envelopes).toHaveLength(1);
        expect(envelopes[0].result.status).toBe('error');
        expect(envelopes[0].result.log.readError).toBeTruthy();
        expect(envelopes[0].result.findings).toEqual([]);
        expect(loggedData()).not.toContain('Unexpected error');
    });

    it('3b. human mode unreadable log: the ✗ cannot-read line, exit 1', async () => {
        const missingPath = join(fakeHome(), 'no-such-dir', 'console.txt');

        const caught = await runLogs(['--log', missingPath]);

        expect(caught).toBeInstanceOf(CliError);
        expect(loggedData()).toContain('✗ cannot read');
        expect(loggedData()).toContain(missingPath);
    });

    it('4. default path: no --log targets <home>/Zomboid/console.txt', async () => {
        const caught = await runLogs(['--json']);

        expect(caught).toBeInstanceOf(CliError);
        const envelope = jsonEnvelopes()[0];
        expect(envelope.result.log.path).toBe(defaultLogPath());
        expect(envelope.result.log.readError).toBeTruthy();
        expect(envelope.result.status).toBe('error');
    });

    it('5. --debug-logs: summary mentions the DEBUG count, DEBUG lines never produce findings', async () => {
        const logPath = seedLog(DEBUG_SESSION);

        const caught = await runLogs(['--log', logPath, '--debug-logs']);
        expect(caught).toBeUndefined();

        let out = loggedData();
        expect(out).toContain('Debug lines: 3 (Animation: 3)');
        expect(out).toContain(
            '[script-warning] Could not find icon: Build_AnvilStone, script = Stone Anvil',
        );
        expect(out).not.toContain('[unclassified]');
        expect(out).toContain('Summary: 0 error(s), 1 warning(s), 0 info(s).');
        expect(out).not.toContain("The log shows no 'GameThread exited.'");

        logCalls = [];
        const caught2 = await runLogs(['--log', logPath]);
        expect(caught2).toBeUndefined();

        out = loggedData();
        expect(out).toContain('Debug lines: 3 (Animation: 3)');
        expect(out).toContain('[script-warning]');
        expect(out).not.toContain('[unclassified]');
    });

    it('6. game still running: the verbatim advisory line', async () => {
        const logPath = seedLog([
            'WARN : General      f:0 at LoadComponentInfo                   > Could not find icon: Build_AnvilStone',
        ]);

        const caught = await runLogs(['--log', logPath]);
        expect(caught).toBeUndefined();

        expect(loggedData()).toContain(
            "⚠ The log shows no 'GameThread exited.' — the game may still be running; results may be partial.",
        );
    });

    it('7. consoleLogHost: default path + project context mapping', async () => {
        expect(buildProjectContext(join(fakeHome(), 'empty'))).toBeUndefined();

        const report = await analyzeGameLogFile(undefined);
        expect(report.log.path).toBe(defaultLogPath());
        expect(report.log.readError).toBeTruthy();

        const projectPath = seedProject();
        const context = buildProjectContext(projectPath);
        expect(context?.mods).toEqual([
            {
                modId: 'zul_test_dev',
                displayName: 'ZUL Test',
                sourceRootUri: join(projectPath, 'zul_test_dev'),
            },
        ]);
    });

    it('8. importing the CLI entry alone registers logs in a fresh registry', async () => {
        vi.resetModules();
        await import('../../packages/cli/src/lib/cli');
        const registry = await import('../../packages/cli/src/lib/registry');
        expect(registry.getCommand('logs')).toBeDefined();
    });
});
