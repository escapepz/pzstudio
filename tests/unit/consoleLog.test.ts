import { describe, it, expect } from 'vitest';
import {
    assembleEntries,
    extractFrames,
} from '../../packages/core/src/consoleLogParse';
import { buildFindings } from '../../packages/core/src/consoleLog';

/**
 * Stage-3 classifiers, dedup, session tables and stats. Fixture lines are
 * verbatim captures from real game logs (paths sanitized to `<user>`) — do
 * not adjust their spacing, casing or paths. Where the brief marks a `…` the
 * caller/body tail is reconstructed in the real evidence style (caller padded
 * to the 36-column `at <caller> > ` layout).
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
