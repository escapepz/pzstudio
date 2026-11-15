import { describe, it, expect } from 'vitest';
import type {
    DirectoryEntry,
    FileStat,
    ProjectFileSystem,
} from '@pzstudio/platform';
import {
    assembleEntries,
    extractFrames,
} from '../../packages/core/src/consoleLogParse';
import {
    analyzeConsoleLog,
    buildFindings,
} from '../../packages/core/src/consoleLog';
import type { ConsoleLogProjectContext } from '../../packages/core/src/consoleLog';

/**
 * Stage-3 classifiers, dedup, session tables and stats, plus the Task-4
 * attribution ladder and the full `analyzeConsoleLog` contract. Fixture lines
 * are verbatim captures from real game logs (paths sanitized to `<user>`) —
 * do not adjust their spacing, casing or paths. Where the brief marks a `…`
 * the caller/body tail is reconstructed in the real evidence style (caller
 * padded to the 36-column `at <caller> > ` layout).
 */

/**
 * Real captured error block (deliberate Lua syntax-error session), identical
 * to the consoleLogParse fixture: leading tabs, double-tab frame indentation
 * and the `require` backticks are significant.
 */
const ERROR_BLOCK = [
    'ERROR: General      f:0> LuaManager.RunLuaInternal> Exception thrown',
    "\tse.krka.kahlua.vm.KahluaException: zul_test_client.lua:43: '}' expected (to close '{' at line 40) near `require` at Lua.zul_test_client.lua(zul_test_client.lua:43).",
    '\tStack trace:',
    '\t\tLua.zul_test_client.lua(zul_test_client.lua:43)',
    '\t\torg.luaj.kahluafork.compiler.LexState.lexerror(LexState.java:274)',
    '\t\t...',
    '\t\tzombie.Lua.LuaManager.RunLuaInternal(LuaManager.java:1373)',
];

describe('consoleLog buildFindings Mod-channel session tables', () => {
    it('collects loaded mods and maps overrides without emitting findings', () => {
        const result = assembleEntries([
            'LOG  : Mod          f:0> loading zul_test_dev',
            'LOG  : Mod          f:0> mod "zul_test_dev" overrides icon.png',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.session.loadedModIds).toEqual(['zul_test_dev']);
        expect(res.tables.overrideMap.get('icon.png')).toBe('zul_test_dev');
        expect(res.findings).toHaveLength(0);
    });

    it('turns `refusing to list` into one mod-rejected finding', () => {
        const result = assembleEntries([
            'LOG  : Mod          f:0> loading zul_test_dev',
            'LOG  : Mod          f:0> refusing to list examplemod',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.session.loadedModIds).toContain('zul_test_dev');
        expect(res.session.rejectedModIds).toEqual(['examplemod']);
        expect(res.findings).toHaveLength(1);
        expect(res.findings[0]).toMatchObject({
            category: 'mod-rejected',
            severity: 'error',
            message: 'refusing to list examplemod',
            modId: 'examplemod',
        });
    });

    it('maps overridden virtual paths to the overriding mod id', () => {
        const result = assembleEntries([
            'LOG  : Mod          f:0> mod "zul_test_dev" overrides media/lua/server/WorldGen/WorldGen.lua',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(
            res.tables.overrideMap.get(
                'media/lua/server/WorldGen/WorldGen.lua',
            ),
        ).toBe('zul_test_dev');
    });
});

describe('consoleLog buildFindings single-line classifiers', () => {
    it('classifies body-prefix matches with table severity', () => {
        const result = assembleEntries([
            'WARN : Lua          f:0 at Lua(Vanilla).corpseStorageCheck     > require("pzapi/ui/ui") failed',
            'WARN : Lua          f:0 at Lua(Vanilla).corpseStorageCheck     > recursive require(): C:/Users/<user>/Zomboid/mods/loop/a.lua',
            'WARN : General      f:0 at LoadComponentInfo                   > Could not find icon: Build_AnvilStone, script = Stone Anvil',
            "ERROR: General      f:0> Sanitizing container name 'Fuel Pump', renamed to fuel_pump",
            'WARN : General      f:0> Missing translation "UI_MyMod_Option"',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.findings.map((finding) => finding.category)).toEqual([
            'require-failure',
            'recursive-require',
            'script-warning',
            'script-warning',
            'translation',
        ]);
        // Table severity is warning even when the envelope level is ERROR
        // (the Sanitizing container name line).
        expect(
            res.findings.every((finding) => finding.severity === 'warning'),
        ).toBe(true);
        expect(res.findings[0].message).toBe('require("pzapi/ui/ui") failed');
        expect(res.findings[4].message).toBe(
            'Missing translation "UI_MyMod_Option"',
        );
    });
});

describe('consoleLog buildFindings continuation promotion', () => {
    it('promotes the real Kahlua block to one lua-syntax-error finding', () => {
        const result = assembleEntries(ERROR_BLOCK);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.findings).toHaveLength(1);
        const finding = res.findings[0];
        expect(finding.category).toBe('lua-syntax-error');
        expect(finding.severity).toBe('error');
        expect(finding.message).toBe(
            "'}' expected (to close '{' at line 40) near `require`",
        );
        expect(finding.line).toBe(43);
        expect(finding.frames).toEqual(
            extractFrames(result.entries[0].continuations),
        );
        expect(finding.frames).toHaveLength(3);
        expect(finding.count).toBe(1);
        expect(finding.firstLine).toBe(1);
        expect(finding.lastLine).toBe(1);
    });

    it('classifies ERROR entries with zombie.* frames as engine-exception', () => {
        const result = assembleEntries([
            'ERROR: General      f:0> ExceptionLogger.logException> Exception thrown',
            '\tat zombie.inventory.ItemPickerJava.ExtractContainersFromFromLua(ItemPickerJava.java:292)',
            '\tat zombie.Lua.LuaManager.RunLuaInternal(LuaManager.java:1373)',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.findings).toHaveLength(1);
        expect(res.findings[0].category).toBe('engine-exception');
        expect(res.findings[0].severity).toBe('error');
        expect(res.findings[0].frames?.map((frame) => frame.kind)).toEqual([
            'engine',
            'engine',
        ]);
    });

    it('keeps ERROR entries with neither KahluaException nor zombie.* frames unclassified', () => {
        const result = assembleEntries([
            'ERROR: General      f:0> SomeJavaCaller> Exception thrown',
            '\tat java.base/java.lang.Thread.run(Thread.java:833)',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.findings).toHaveLength(1);
        expect(res.findings[0].category).toBe('unclassified');
        expect(res.findings[0].severity).toBe('error');
        expect(res.findings[0].message).toBe(
            'Exception thrown\n\tat java.base/java.lang.Thread.run(Thread.java:833)',
        );
    });
});

describe('consoleLog buildFindings DEBUG count-and-drop', () => {
    it('counts DEBUG lines per channel and level with zero findings', () => {
        const result = assembleEntries([
            'DEBUG: Animation    f:0 at AnimationSet.Load                   > Loading AnimSet: Base',
            'DEBUG: Animation    f:0 at AnimationSet.Load                   > Loading AnimSet: Base',
            'DEBUG: Animation    f:0 at AnimationSet.Load                   > Loading AnimSet: Base',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.stats.debugByChannel.Animation).toBe(3);
        expect(res.stats.byLevel.DEBUG).toBe(3);
        expect(res.findings).toHaveLength(0);
    });
});

describe('consoleLog buildFindings dedup', () => {
    it('collapses identical warnings into one counted finding spanning their lines', () => {
        const result = assembleEntries([
            'WARN : General      f:0 at XuiSkin$EntityUiStyle.Load          > Could not find icon: Build_AnvilStone',
            'WARN : General      f:0 at XuiSkin$EntityUiStyle.Load          > Could not find icon: Build_AnvilStone',
            'WARN : General      f:0 at XuiSkin$EntityUiStyle.Load          > Could not find icon: Build_AnvilStone',
            'WARN : General      f:0 at LoadComponentInfo                   > Could not find icon: Build_AnvilStone, script = Stone Anvil',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.findings).toHaveLength(2);
        expect(res.findings[0]).toMatchObject({
            category: 'script-warning',
            severity: 'warning',
            message: 'Could not find icon: Build_AnvilStone',
            count: 3,
            firstLine: 1,
            lastLine: 3,
        });
        expect(res.findings[1]).toMatchObject({
            category: 'script-warning',
            severity: 'warning',
            message:
                'Could not find icon: Build_AnvilStone, script = Stone Anvil',
            count: 1,
            firstLine: 4,
            lastLine: 4,
        });
    });
});

describe('consoleLog buildFindings unclassified invariant', () => {
    it('routes unmatched ERROR bodies to unclassified with the message preserved', () => {
        const result = assembleEntries([
            'ERROR: General      f:0> WeirdThing> totally unknown failure',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.findings).toHaveLength(1);
        expect(res.findings[0]).toMatchObject({
            category: 'unclassified',
            severity: 'error',
            message: 'totally unknown failure',
        });
    });
});

describe('consoleLog buildFindings session metadata', () => {
    it('captures sessionStart and gameExited from the General channel', () => {
        const result = assembleEntries([
            'LOG  : General      f:0> 15-11-2026 13:28:36',
            'LOG  : General      f:3979> GameThread exited.',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.sessionStart).toBe('15-11-2026 13:28:36');
        expect(res.gameExited).toBe(true);
        expect(res.findings).toHaveLength(0);
        expect(res.stats.byLevel.LOG).toBe(2);
    });
});

describe('consoleLog buildFindings stats passthrough', () => {
    it('passes totalLines and junkCount through untouched', () => {
        const result = assembleEntries([
            'LOG  : General      f:0> some informational line',
            '"]',
        ]);
        const res = buildFindings(
            result.entries,
            result.totalLines,
            result.junkCount,
        );
        expect(res.stats.totalLines).toBe(result.totalLines);
        expect(res.stats.junkCount).toBe(result.junkCount);
        expect(res.stats.junkCount).toBe(1);
        expect(res.sessionStart).toBeUndefined();
        expect(res.gameExited).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Task 4: attribution ladder + full analyzeConsoleLog contract
// ---------------------------------------------------------------------------

/**
 * In-memory ProjectFileSystem fake (brief): a `Map<string, Uint8Array>` of
 * file contents; `list` derives direct children from the map keys. Defined
 * once here for every analyzeConsoleLog suite below.
 */
class FakeProjectFileSystem implements ProjectFileSystem {
    files = new Map<string, Uint8Array>();

    async read(uri: string): Promise<Uint8Array> {
        const data = this.files.get(uri);
        if (data === undefined) throw new Error(`ENOENT: ${uri}`);
        return data;
    }

    async write(uri: string, data: Uint8Array): Promise<void> {
        this.files.set(uri, data);
    }

    async delete(uri: string): Promise<void> {
        this.files.delete(uri);
    }

    async stat(uri: string): Promise<FileStat> {
        const data = this.files.get(uri);
        if (data !== undefined) {
            return { type: 'file', ctime: 0, mtime: 0, size: data.length };
        }
        const prefix = uri.endsWith('/') ? uri : `${uri}/`;
        for (const key of this.files.keys()) {
            if (key.startsWith(prefix)) {
                return { type: 'directory', ctime: 0, mtime: 0, size: 0 };
            }
        }
        throw new Error(`ENOENT: ${uri}`);
    }

    async list(uri: string): Promise<DirectoryEntry[]> {
        const prefix = uri.endsWith('/') ? uri : `${uri}/`;
        const names = new Map<string, DirectoryEntry['type']>();
        for (const key of this.files.keys()) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const slash = rest.indexOf('/');
            if (slash === -1) {
                names.set(rest, 'file');
            } else {
                names.set(rest.slice(0, slash), 'directory');
            }
        }
        return [...names.entries()].map(([name, type]) => ({
            name,
            uri: `${prefix}${name}`,
            type,
        }));
    }

    /** Test convenience: writes a UTF-8 text file. */
    async writeText(uri: string, content: string): Promise<void> {
        await this.write(uri, new TextEncoder().encode(content));
    }
}

/** Writes the given lines as the log file under analysis; returns its URI. */
async function writeLog(
    fs: FakeProjectFileSystem,
    lines: string[],
): Promise<string> {
    const logUri = 'mem://logs/console.txt';
    await fs.writeText(logUri, lines.join('\n'));
    return logUri;
}

// Real session-2 shapes (verbatim, sanitized) plus the `GameThread exited.`
// tail, assembled per the brief.
const SESSION_START_LINE = 'LOG  : General      f:0> 15-11-2026 13:28:36';
const LOADING_ZUL_TEST = 'LOG  : Mod          f:0> loading zul_test_dev';
const LOADING_ZUL = 'LOG  : Mod          f:0> loading zul_dev';
const REFUSING_EXAMPLEMOD =
    'LOG  : Mod          f:0> refusing to list examplemod';
const JUL_HEADER_LINE =
    'Nov 15, 2026 1:30:13 PM zombie.Lua.LuaManager RunLuaInternal]';
const SEVERE_ZUL_PATH =
    'SEVERE: Error found in LUA file: C:/Users/<user>/Zomboid/Workshop/ZUL - Zomboid Unified Logging - dev_branch/Contents/mods/zul_test_dev/42/media/lua/client/zul_test_client.lua';
const GAME_EXITED_LINE = 'LOG  : General      f:3979> GameThread exited.';

const ZUL_WORKSPACE_FILE =
    'file:///proj/zul_test_dev/42/media/lua/client/zul_test_client.lua';
const ZUL_COMMON_WORKSPACE_FILE =
    'file:///proj/zul_test_dev/common/media/lua/client/zul_test_client.lua';

const ZUL_CONTEXT: ConsoleLogProjectContext = {
    mods: [
        {
            modId: 'zul_test_dev',
            displayName: 'ZUL Test',
            sourceRootUri: 'file:///proj/zul_test_dev',
        },
        { modId: 'zul_dev', sourceRootUri: 'file:///proj/zul_dev' },
    ],
};

describe('consoleLog analyzeConsoleLog full attribution', () => {
    it('attributes the syntax error via the SEVERE path and keeps the classifier modId', async () => {
        const fs = new FakeProjectFileSystem();
        const logLines = [
            SESSION_START_LINE,
            LOADING_ZUL_TEST,
            LOADING_ZUL,
            REFUSING_EXAMPLEMOD,
            JUL_HEADER_LINE,
            SEVERE_ZUL_PATH,
            ...ERROR_BLOCK,
            GAME_EXITED_LINE,
        ];
        const logUri = await writeLog(fs, logLines);
        // The game-install copy at the SEVERE path exists too — click-to-file
        // must still resolve to the workspace URI, never the game path.
        await fs.writeText(
            'file:///game/Contents/mods/zul_test_dev/42/media/lua/client/zul_test_client.lua',
            '-- game copy\n',
        );
        await fs.writeText(ZUL_WORKSPACE_FILE, '-- workspace copy\n');

        const report = await analyzeConsoleLog(fs, logUri, ZUL_CONTEXT);

        expect(report.findings).toHaveLength(3);
        const syntax = report.findings.find(
            (finding) => finding.category === 'lua-syntax-error',
        );
        expect(syntax).toMatchObject({
            modId: 'zul_test_dev',
            sourceFile: ZUL_WORKSPACE_FILE,
            line: 43,
        });
        const rejected = report.findings.find(
            (finding) => finding.category === 'mod-rejected',
        );
        expect(rejected).toMatchObject({ modId: 'examplemod' });
        expect(rejected?.sourceFile).toBeUndefined();
        // The SEVERE line itself (unclassified) carries the same attribution.
        const severeLine = report.findings.find(
            (finding) => finding.category === 'unclassified',
        );
        expect(severeLine).toMatchObject({
            modId: 'zul_test_dev',
            sourceFile: ZUL_WORKSPACE_FILE,
        });
        expect(report.log).toEqual({
            path: logUri,
            sessionStart: '15-11-2026 13:28:36',
            gameExited: true,
            totalLines: logLines.length,
        });
        expect(report.session.loadedModIds).toEqual([
            'zul_test_dev',
            'zul_dev',
        ]);
        expect(report.stats.junkCount).toBe(0);
    });

    it('falls back to the SEVERE path mod folder when no context mod matches', async () => {
        const fs = new FakeProjectFileSystem();
        const logUri = await writeLog(fs, [
            SESSION_START_LINE,
            LOADING_ZUL_TEST,
            JUL_HEADER_LINE,
            SEVERE_ZUL_PATH,
            ...ERROR_BLOCK,
            GAME_EXITED_LINE,
        ]);

        const report = await analyzeConsoleLog(fs, logUri);

        expect(report.findings).toHaveLength(2);
        const syntax = report.findings.find(
            (finding) => finding.category === 'lua-syntax-error',
        );
        expect(syntax).toMatchObject({ modId: 'zul_test_dev', line: 43 });
        expect(syntax?.sourceFile).toBeUndefined();
    });
});

describe('consoleLog analyzeConsoleLog basename tier', () => {
    it('picks the 42 workspace URI over common when the SEVERE line is absent', async () => {
        const fs = new FakeProjectFileSystem();
        const logUri = await writeLog(fs, [
            SESSION_START_LINE,
            LOADING_ZUL_TEST,
            ...ERROR_BLOCK,
            GAME_EXITED_LINE,
        ]);
        await fs.writeText(ZUL_WORKSPACE_FILE, '-- 42 copy\n');
        await fs.writeText(ZUL_COMMON_WORKSPACE_FILE, '-- common copy\n');

        const report = await analyzeConsoleLog(fs, logUri, {
            mods: [
                {
                    modId: 'zul_test_dev',
                    sourceRootUri: 'file:///proj/zul_test_dev',
                },
            ],
        });

        expect(report.findings).toHaveLength(1);
        const syntax = report.findings.find(
            (finding) => finding.category === 'lua-syntax-error',
        );
        expect(syntax).toMatchObject({
            modId: 'zul_test_dev',
            sourceFile: ZUL_WORKSPACE_FILE,
            line: 43,
        });
    });

    it('leaves a basename shared by two loaded context mods unattributed', async () => {
        const fs = new FakeProjectFileSystem();
        const logUri = await writeLog(fs, [
            'LOG  : Mod          f:0> loading mod_a',
            'LOG  : Mod          f:0> loading mod_b',
            'ERROR: General      f:0> LuaManager.RunLuaInternal> Exception thrown',
            '\tse.krka.kahlua.vm.KahluaException: broken.lua:9: unexpected symbol near `x` at Lua.broken.lua(broken.lua:9).',
            '\tStack trace:',
            '\t\tLua.broken.lua(broken.lua:9)',
            GAME_EXITED_LINE,
        ]);
        await fs.writeText(
            'file:///proj/mod_a/42/media/lua/broken.lua',
            '-- a\n',
        );
        await fs.writeText(
            'file:///proj/mod_b/42/media/lua/broken.lua',
            '-- b\n',
        );

        const report = await analyzeConsoleLog(fs, logUri, {
            mods: [
                { modId: 'mod_a', sourceRootUri: 'file:///proj/mod_a' },
                { modId: 'mod_b', sourceRootUri: 'file:///proj/mod_b' },
            ],
        });

        expect(report.findings).toHaveLength(1);
        const syntax = report.findings.find(
            (finding) => finding.category === 'lua-syntax-error',
        );
        expect(syntax?.modId).toBeUndefined();
        expect(syntax?.sourceFile).toBeUndefined();
    });
});

describe('consoleLog analyzeConsoleLog display-name tier', () => {
    it('attributes via the B41 `| MOD:` frame owner resolved against context display names', async () => {
        const fs = new FakeProjectFileSystem();
        const logUri = await writeLog(fs, [
            'LOG  : Mod          f:0> loading trelai',
            'ERROR: General      f:0> SomeJavaCaller> Exception thrown',
            '\tfunction: new -- file: ISHandcraftAction.lua line # 354 | MOD: 1.Trelai Map 4x4',
            GAME_EXITED_LINE,
        ]);

        const report = await analyzeConsoleLog(fs, logUri, {
            mods: [
                {
                    modId: 'trelai',
                    displayName: '1.Trelai Map 4x4',
                    sourceRootUri: 'file:///proj/trelai',
                },
            ],
        });

        expect(report.findings).toHaveLength(1);
        const unclassified = report.findings.find(
            (finding) => finding.category === 'unclassified',
        );
        expect(unclassified?.modId).toBe('trelai');
    });
});

describe('consoleLog analyzeConsoleLog override tier', () => {
    it('attributes recursive-require when a body path token matches an override key', async () => {
        const fs = new FakeProjectFileSystem();
        const logUri = await writeLog(fs, [
            'LOG  : Mod          f:0> mod "zul_test_dev" overrides media/lua/server/WorldGen/WorldGen.lua',
            LOADING_ZUL_TEST,
            'WARN : Lua          f:0 at Lua(Vanilla).corpseStorageCheck     > recursive require(): C:/Program Files (x86)/Steam/steamapps/common/ProjectZomboid/media/lua/server/WorldGen/WorldGen.lua',
            GAME_EXITED_LINE,
        ]);

        const report = await analyzeConsoleLog(fs, logUri, {
            mods: [
                {
                    modId: 'zul_test_dev',
                    sourceRootUri: 'file:///proj/zul_test_dev',
                },
            ],
        });

        expect(report.findings).toHaveLength(1);
        const recursive = report.findings.find(
            (finding) => finding.category === 'recursive-require',
        );
        expect(recursive).toMatchObject({ modId: 'zul_test_dev' });
        expect(recursive?.sourceFile).toBeUndefined();
    });
});

describe('consoleLog analyzeConsoleLog live-log robustness', () => {
    it('resolves with a readError report instead of throwing when the log is locked', async () => {
        const fs = new FakeProjectFileSystem();
        fs.read = async (): Promise<Uint8Array> => {
            throw new Error('EPERM: operation not permitted, open console.txt');
        };

        const report = await analyzeConsoleLog(fs, 'mem://logs/console.txt');

        expect(report.log.readError).toContain('EPERM');
        expect(report.findings).toEqual([]);
        expect(report.session.loadedModIds).toEqual([]);
        expect(report.log.gameExited).toBe(false);
        expect(report.stats.totalLines).toBe(0);
    });

    it('flags a log without the GameThread exit marker as still-running', async () => {
        const fs = new FakeProjectFileSystem();
        const logUri = await writeLog(fs, [
            SESSION_START_LINE,
            LOADING_ZUL_TEST,
            'LOG  : General      f:12> some late chatter',
        ]);

        const report = await analyzeConsoleLog(fs, logUri, ZUL_CONTEXT);

        expect(report.log.gameExited).toBe(false);
        expect(report.log.sessionStart).toBe('15-11-2026 13:28:36');
        expect(report.findings).toEqual([]);
    });
});

describe('consoleLog analyzeConsoleLog includeDebug threading', () => {
    it('keeps DEBUG lines finding-free in both modes but re-enables their session tables', async () => {
        const fs = new FakeProjectFileSystem();
        const logUri = await writeLog(fs, [
            'DEBUG: Animation    f:0 at AnimationSet.Load                   > Loading AnimSet: Base',
            'DEBUG: Animation    f:0 at AnimationSet.Load                   > Loading AnimSet: Base',
            'DEBUG: Mod          f:0> loading zul_test_dev',
        ]);
        const context: ConsoleLogProjectContext = {
            mods: [
                {
                    modId: 'zul_test_dev',
                    sourceRootUri: 'file:///proj/zul_test_dev',
                },
            ],
        };

        const defaultReport = await analyzeConsoleLog(fs, logUri, context);
        expect(defaultReport.findings).toEqual([]);
        expect(defaultReport.stats.debugByChannel.Animation).toBe(2);
        expect(defaultReport.session.loadedModIds).toEqual([]);

        const debugReport = await analyzeConsoleLog(fs, logUri, context, {
            includeDebug: true,
        });
        expect(debugReport.findings).toEqual([]);
        expect(debugReport.stats.debugByChannel.Animation).toBe(2);
        expect(debugReport.session.loadedModIds).toEqual(['zul_test_dev']);
    });
});
