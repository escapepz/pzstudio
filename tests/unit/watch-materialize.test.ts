import { describe, it, expect } from 'vitest';
import path from 'path';
import {
    assertWatchMaterializable,
    parseMaterializeFlag,
    watchIgnoreGlobs,
    isWatchPathIgnored,
    ERR_WATCH_COPY_MODE_UNSUPPORTED,
} from '../../packages/cli/src/lib/watch-shared';
import type { MaterializationResolution } from '../../packages/cli/src/lib/linkStep';

const materialize = (
    overrides: Partial<MaterializationResolution> = {},
): MaterializationResolution => ({
    action: 'materialize',
    mode: 'symlink',
    outDir: 'C:/deploy',
    distRoot: 'C:/proj/dist',
    ...overrides,
});

describe('watch materialize helpers (dist-always amendment §7)', () => {
    describe('parseMaterializeFlag', () => {
        it('passes undefined through (no per-invocation override)', () => {
            expect(parseMaterializeFlag(undefined)).toBeUndefined();
        });

        it('accepts symlink and copy', () => {
            expect(parseMaterializeFlag('symlink')).toBe('symlink');
            expect(parseMaterializeFlag('copy')).toBe('copy');
        });

        it('rejects none — never an enum value', () => {
            expect(() => parseMaterializeFlag('none')).toThrow(
                'Invalid --materialize value "none"',
            );
        });

        it('rejects any other value naming the flag', () => {
            expect(() => parseMaterializeFlag('hardlink')).toThrow(
                /--materialize/,
            );
        });
    });

    describe('assertWatchMaterializable', () => {
        it('refuses copy mode with the structured code and the three escapes', () => {
            let thrown: unknown;
            try {
                assertWatchMaterializable(materialize({ mode: 'copy' }));
            } catch (e) {
                thrown = e;
            }
            const cliErr = thrown as {
                message: string;
                cause?: unknown;
                tryHint?: string;
            };
            expect(cliErr).toBeDefined();
            expect(String(cliErr.message)).toContain(
                'watch cannot deploy in copy mode',
            );
            expect(String(cliErr.cause)).toContain(
                ERR_WATCH_COPY_MODE_UNSUPPORTED,
            );
            expect(String(cliErr.tryHint)).toContain(
                '"materialize": "symlink"',
            );
            expect(String(cliErr.tryHint)).toContain('pzstudio build');
            expect(String(cliErr.tryHint)).toContain('--no-materialize');
        });

        it('allows symlink mode', () => {
            expect(() =>
                assertWatchMaterializable(materialize({ mode: 'symlink' })),
            ).not.toThrow();
        });

        it('allows skip (no target or --no-materialize) regardless of mode', () => {
            expect(() =>
                assertWatchMaterializable(
                    materialize({ action: 'skip', mode: 'copy' }),
                ),
            ).not.toThrow();
        });
    });

    describe('watchIgnoreGlobs', () => {
        const project = 'C:/proj';

        it('ignores the dist root when it sits inside the project', () => {
            expect(
                watchIgnoreGlobs(project, path.join(project, 'dist')),
            ).toEqual(['dist', 'dist/**']);
        });

        it('adds the deployment root when it sits inside the project (junction loop)', () => {
            expect(
                watchIgnoreGlobs(
                    project,
                    path.join(project, 'dist'),
                    path.join(project, 'deploy'),
                ),
            ).toEqual(['dist', 'dist/**', 'deploy', 'deploy/**']);
        });

        it('drops a deployment root outside the project (the watcher never sees it)', () => {
            expect(
                watchIgnoreGlobs(
                    project,
                    path.join(project, 'dist'),
                    'C:/Users/me/Zomboid/Workshop',
                ),
            ).toEqual(['dist', 'dist/**']);
        });

        it('returns undefined when the engine root is outside the project', () => {
            expect(
                watchIgnoreGlobs(project, 'C:/Users/me/Zomboid/Workshop'),
            ).toBeUndefined();
        });
    });

    describe('isWatchPathIgnored with a deployment root', () => {
        const project = path.resolve('C:/proj');
        const dist = path.join(project, 'dist');
        const deploy = path.join(project, 'deploy');

        it('ignores events under the in-project deployment root', () => {
            expect(
                isWatchPathIgnored(
                    project,
                    dist,
                    path.join(deploy, 'My Item', 'workshop.txt'),
                    deploy,
                ),
            ).toBe(true);
        });

        it('keeps legitimate source events outside both roots', () => {
            expect(
                isWatchPathIgnored(
                    project,
                    dist,
                    path.join(project, 'my_mod', 'media', 'lua', 'a.lua'),
                    deploy,
                ),
            ).toBe(false);
        });

        it('keeps the deployment-root check inert when the root is outside the project', () => {
            // An external deploy root never enters the loop check — but an
            // IN-PROJECT source under the same watch must stay delivered.
            const external = path.resolve('C:/deploy-external');
            expect(
                isWatchPathIgnored(
                    project,
                    dist,
                    path.join(project, 'my_mod', 'media', 'lua', 'b.lua'),
                    external,
                ),
            ).toBe(false);
        });
    });
});
