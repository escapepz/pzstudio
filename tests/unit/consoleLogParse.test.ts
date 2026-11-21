import { describe, it, expect } from 'vitest';
import {
    assembleEntries,
    extractFrames,
    extractKahluaException,
    peelLine,
} from '../../packages/core/src/consoleLogParse';

describe('consoleLogParse peelLine', () => {
    it('peels the padded envelope without a caller', () => {
        const p = peelLine('LOG  : General      f:0> 15-11-2026 13:28:36');
        expect(p).toMatchObject({
            kind: 'envelope',
            level: 'LOG',
            channel: 'General',
            frame: 0,
            body: '15-11-2026 13:28:36',
        });
    });

    it('peels the padded envelope with a padded at-caller', () => {
        const p = peelLine(
            'ERROR: General      f:0 at AngelCodeFont.parseFnt              > AngelCodeFont failed to load page 0 texture C:/Program Files (x86)/Steam/steamapps/common/ProjectZomboid/media/mainfont_0.png',
        );
        expect(p).toMatchObject({
            kind: 'envelope',
            level: 'ERROR',
            channel: 'General',
            frame: 0,
            caller: 'AngelCodeFont.parseFnt',
            body: 'AngelCodeFont failed to load page 0 texture C:/Program Files (x86)/Steam/steamapps/common/ProjectZomboid/media/mainfont_0.png',
        });
    });

    it('tolerates config-gated t:/st: metadata', () => {
        const p = peelLine(
            'LOG  : General      f:132415, t:1767275501581, st:1,855,515,705> x',
        );
        expect(p.frame).toBe(132415);
        expect(p.body).toBe('x');
    });

    it('promotes a body-embedded caller', () => {
        const p = peelLine(
            'ERROR: General      f:0> LuaManager.RunLuaInternal> Exception thrown',
        );
        expect(p).toMatchObject({
            kind: 'envelope',
            level: 'ERROR',
            caller: 'LuaManager.RunLuaInternal',
            body: 'Exception thrown',
        });
    });

    it('keeps embedded ERROR text in the body at LOG level', () => {
        const p = peelLine(
            'LOG  : General      f:0> 111ERROR: not adding suspicious zone "" "Nav" 8343,12316,0 2244x18',
        );
        expect(p).toMatchObject({
            kind: 'envelope',
            level: 'LOG',
            caller: undefined,
            body: '111ERROR: not adding suspicious zone "" "Nav" 8343,12316,0 2244x18',
        });
    });

    it('peels the SEVERE family with spaces in the path', () => {
        const p = peelLine(
            'SEVERE: Error found in LUA file: C:/Users/<user>/Zomboid/Workshop/ZUL - Zomboid Unified Logging - dev_branch/Contents/mods/zul_test_dev/42/media/lua/client/zul_test_client.lua',
        );
        expect(p).toMatchObject({
            kind: 'severe',
            level: 'SEVERE',
            body: 'Error found in LUA file: C:/Users/<user>/Zomboid/Workshop/ZUL - Zomboid Unified Logging - dev_branch/Contents/mods/zul_test_dev/42/media/lua/client/zul_test_client.lua',
        });
    });

    it('peels the JUL header family', () => {
        const p = peelLine(
            'Nov 15, 2026 1:30:13 PM zombie.Lua.LuaManager RunLuaInternal]',
        );
        expect(p).toMatchObject({
            kind: 'jul-header',
            julClass: 'zombie.Lua.LuaManager',
            julMethod: 'RunLuaInternal',
        });
    });

    it('peels the DEBUG level and Lua caller', () => {
        const p = peelLine(
            'WARN : Lua          f:0 at Lua(Vanilla).corpseStorageCheck     > require("ISUI/ISInventoryPaneContextMenu") failed',
        );
        expect(p).toMatchObject({
            kind: 'envelope',
            level: 'WARN',
            channel: 'Lua',
            caller: 'Lua(Vanilla).corpseStorageCheck',
            body: 'require("ISUI/ISInventoryPaneContextMenu") failed',
        });
    });

    it('peels the NOISE envelope level', () => {
        const p = peelLine('NOISE: General      f:0> x');
        expect(p).toMatchObject({
            kind: 'envelope',
            level: 'NOISE',
            channel: 'General',
            frame: 0,
            body: 'x',
        });
    });

    it('marks junk as other', () => {
        expect(peelLine('"]').kind).toBe('other');
        expect(peelLine('').kind).toBe('other');
    });
});

const ERROR_BLOCK = [
    'ERROR: General      f:0> LuaManager.RunLuaInternal> Exception thrown',
    "\tse.krka.kahlua.vm.KahluaException: zul_test_client.lua:43: '}' expected (to close '{' at line 40) near `require` at Lua.zul_test_client.lua(zul_test_client.lua:43).",
    '\tStack trace:',
    '\t\tLua.zul_test_client.lua(zul_test_client.lua:43)',
    '\t\torg.luaj.kahluafork.compiler.LexState.lexerror(LexState.java:274)',
    '\t\t...',
    '\t\tzombie.Lua.LuaManager.RunLuaInternal(LuaManager.java:1373)',
];

describe('consoleLogParse assembleEntries', () => {
    it('assembles the real Kahlua syntax-error block into one envelope entry', () => {
        const lines = [...ERROR_BLOCK, '"]'];
        const result = assembleEntries(lines);
        expect(result.entries).toHaveLength(1);
        const entry = result.entries[0];
        expect(entry.kind).toBe('envelope');
        expect(entry.level).toBe('ERROR');
        expect(entry.channel).toBe('General');
        expect(entry.frame).toBe(0);
        expect(entry.caller).toBe('LuaManager.RunLuaInternal');
        expect(entry.body).toBe('Exception thrown');
        expect(entry.lineNo).toBe(1);
        expect(entry.continuations).toEqual(ERROR_BLOCK.slice(1));
        expect(entry.continuationsCapped).toBe(false);
        expect(result.junkCount).toBe(1);
        expect(result.totalLines).toBe(lines.length);
    });

    it('starts a new entry at every envelope line with 1-based lineNo', () => {
        const result = assembleEntries([
            'LOG  : General      f:0> first',
            '\tattached to the first entry',
            'ERROR: General      f:0> second',
            '"]',
        ]);
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].lineNo).toBe(1);
        expect(result.entries[0].continuations).toEqual([
            '\tattached to the first entry',
        ]);
        expect(result.entries[1].lineNo).toBe(3);
        expect(result.entries[1].continuations).toHaveLength(0);
        expect(result.junkCount).toBe(1);
    });

    it('opens jul-header entries with body=raw and no level, severe entries with level', () => {
        const result = assembleEntries([
            'Nov 15, 2026 1:30:13 PM zombie.Lua.LuaManager RunLuaInternal]',
            'SEVERE: Error found in LUA file: C:/Zomboid/mods/x.lua',
            '\texception detail',
        ]);
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].kind).toBe('jul-header');
        expect(result.entries[0].body).toBe(
            'Nov 15, 2026 1:30:13 PM zombie.Lua.LuaManager RunLuaInternal]',
        );
        expect(result.entries[0].level).toBeUndefined();
        expect(result.entries[0].continuations).toHaveLength(0);
        expect(result.entries[1].kind).toBe('severe');
        expect(result.entries[1].level).toBe('SEVERE');
        expect(result.entries[1].body).toBe(
            'Error found in LUA file: C:/Zomboid/mods/x.lua',
        );
        expect(result.entries[1].continuations).toEqual(['\texception detail']);
    });

    it('caps continuations at 64 lines and flags the entry', () => {
        const lines = ['ERROR: General      f:0> boom'];
        for (let i = 0; i < 70; i += 1) {
            lines.push('\tframe line ' + i);
        }
        const result = assembleEntries(lines);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].continuations).toHaveLength(64);
        expect(result.entries[0].continuationsCapped).toBe(true);
        expect(result.junkCount).toBe(6);
    });
});

describe('consoleLogParse extractKahluaException', () => {
    it('extracts basename, line and message from the real block', () => {
        expect(extractKahluaException(ERROR_BLOCK.slice(1))).toEqual({
            basename: 'zul_test_client.lua',
            line: 43,
            message: "'}' expected (to close '{' at line 40) near `require`",
        });
    });

    it('returns null when no Kahlua exception line is present', () => {
        expect(
            extractKahluaException([
                '\tStack trace:',
                '\t\tzombie.Lua.LuaManager.RunLuaInternal(LuaManager.java:1373)',
            ]),
        ).toBeNull();
        expect(extractKahluaException([])).toBeNull();
    });
});

describe('consoleLogParse extractFrames', () => {
    it('classifies the real block frames: lua, lua-vm, engine', () => {
        const frames = extractFrames(ERROR_BLOCK.slice(1));
        expect(frames).toHaveLength(3);
        expect(frames[0]).toMatchObject({
            kind: 'lua',
            text: 'Lua.zul_test_client.lua(zul_test_client.lua:43)',
            file: 'zul_test_client.lua',
            line: 43,
            owner: undefined,
        });
        expect(frames[1]).toMatchObject({
            kind: 'lua-vm',
            text: 'org.luaj.kahluafork.compiler.LexState.lexerror(LexState.java:274)',
        });
        expect(frames[2]).toMatchObject({
            kind: 'engine',
            text: 'zombie.Lua.LuaManager.RunLuaInternal(LuaManager.java:1373)',
        });
    });

    it('parses dormant B42 synthetic Lua frames with their owner', () => {
        const frames = extractFrames([
            '\t\tLua((MOD:Example Mod)).myFunc(myfile.lua:14)',
            '\t\tLua(Vanilla).corpseStorageCheck(van.lua:7)',
            '\t\tLua(BuiltIn).getSprite(sprite.lua:9)',
        ]);
        expect(frames).toHaveLength(3);
        expect(frames[0]).toMatchObject({
            kind: 'lua',
            owner: 'Example Mod',
            file: 'myfile.lua',
            line: 14,
        });
        expect(frames[1]).toMatchObject({
            kind: 'lua',
            owner: 'Vanilla',
            file: 'van.lua',
            line: 7,
        });
        expect(frames[2]).toMatchObject({
            kind: 'lua',
            file: 'sprite.lua',
            line: 9,
        });
    });

    it('parses dormant B41 Kahlua frames, owner only for MOD: suffixes', () => {
        const frames = extractFrames([
            'function: new -- file: ISHandcraftAction.lua line # 354 | Vanilla',
            'function: onUpdate -- file: othermod.lua line # 12 | MOD: 1.Trelai Map 4x4',
        ]);
        expect(frames).toHaveLength(2);
        expect(frames[0]).toMatchObject({
            kind: 'lua',
            file: 'ISHandcraftAction.lua',
            line: 354,
            owner: undefined,
        });
        expect(frames[1]).toMatchObject({
            kind: 'lua',
            file: 'othermod.lua',
            line: 12,
            owner: '1.Trelai Map 4x4',
        });
    });

    it('classifies lua-vm, engine and jvm frames by package prefix', () => {
        const frames = extractFrames([
            '\tse.krka.kahlua.vm.KahluaThread.luaMainloop(KahluaThread.java:976)',
            '\tat zombie.Lua.LuaManager.RunLuaInternal(LuaManager.java:1373)',
            '\tjava.base/java.lang.Thread.run(Thread.java:833)',
        ]);
        expect(frames.map((frame) => frame.kind)).toEqual([
            'lua-vm',
            'engine',
            'jvm',
        ]);
        expect(frames[1].text).toBe(
            'zombie.Lua.LuaManager.RunLuaInternal(LuaManager.java:1373)',
        );
    });

    it('never turns captions, separators or the exception headline into frames', () => {
        expect(
            extractFrames([
                '\tStack trace:',
                '\tCaused by: java.lang.IllegalStateException: exploded',
                '\t\tSuppressed: java.lang.Exception: hidden',
                '\t\t...',
                '\t---------',
                '\tse.krka.kahlua.vm.KahluaException: zul_test_client.lua:43: boom at Lua.zul_test_client.lua(zul_test_client.lua:43).',
            ]),
        ).toHaveLength(0);
    });
});
