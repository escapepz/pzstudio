import { describe, it, expect } from 'vitest';
import { peelLine } from '../../packages/core/src/consoleLogParse';

/**
 * Envelope peelers for Project Zomboid console.txt lines. Fixture lines are
 * verbatim captures from real game logs (paths sanitized to `<user>`); do
 * not adjust their spacing, casing or paths.
 */
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

    it('marks junk as other', () => {
        expect(peelLine('"]').kind).toBe('other');
        expect(peelLine('').kind).toBe('other');
    });
});
