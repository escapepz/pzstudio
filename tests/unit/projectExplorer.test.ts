'use strict';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── vscode mock ─────────────────────────────────────────────────────────────

type MockUri = { path: string; joinPath?: unknown };

const vscodeMock = vi.hoisted(() => {
    const makeUri = (parts: string[]): MockUri => {
        const uri: MockUri = {
            path: '/' + parts.join('/'),
            joinPath: undefined,
        };
        return uri;
    };
    return {
        Uri: {
            joinPath: (base: MockUri, ...rest: string[]): MockUri => {
                const baseParts = base.path.split('/').filter(Boolean);
                return makeUri([...baseParts, ...rest]);
            },
            file: (path: string): MockUri =>
                makeUri(path.split('/').filter(Boolean)),
        },
        FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        TreeItem: class {
            label: unknown;
            collapsible: unknown;
            constructor(label: unknown, collapsible: unknown) {
                this.label = label;
                this.collapsible = collapsible;
            }
        },
        ThemeIcon: class {
            id: string;
            constructor(id: string) {
                this.id = id;
            }
        },
        EventEmitter: class {
            event = vi.fn();
            fire = vi.fn();
            dispose = vi.fn();
        },
        l10n: {
            // Pass-through: assertions compare against the English keys.
            t: (message: string, ...args: (string | number)[]): string =>
                args.reduce(
                    (acc, arg, i) => acc.replaceAll(`{${i}}`, String(arg)),
                    message,
                ),
        },
        workspace: { fs: {} },
    };
});

vi.mock('vscode', () => ({ ...vscodeMock, default: vscodeMock }));

// ── import after mock ────────────────────────────────────────────────────────
import {
    naturalCompare,
    resolveModFolderIcon,
    ProjectExplorerProvider,
    REFRESH_DEBOUNCE_MS,
    SHOW_ALL_FILES_CONTEXT_KEY,
    PROJECT_FOLDER_ICON_LIGHT,
    PROJECT_FOLDER_ICON_DARK,
    MOD_BRANCH_INFO_FILE,
    MOD_BRANCH_ICON_FILE,
} from '../../packages/vscode-extension/src/providers/projectExplorer';

const asUri = (path: string) =>
    vscodeMock.Uri.joinPath(vscodeMock.Uri.joinPath({ path: '' }), path);

const FileType = vscodeMock.FileType;

type Entry = [string, number];

/**
 * Builds an in-memory listDir/stat pair from a tree like
 * { '42': { 'mod.info': 'file', 'icon.png': 'file' } }.
 */
function makeFs(
    tree: Record<string, Record<string, 'file' | 'dir' | undefined>>,
) {
    const listDir = vi.fn(async (dir: { path: string }) => {
        const segs = dir.path.split('/').filter(Boolean);
        let node: unknown = tree;
        for (const seg of segs) {
            node = (node as Record<string, unknown>)?.[seg];
        }
        if (!node || typeof node !== 'object') {
            throw new Error('ENOENT');
        }
        return Object.entries(node as Record<string, unknown>).map(
            ([name, value]): Entry => [
                name,
                value !== null && typeof value === 'object'
                    ? FileType.Directory
                    : FileType.File,
            ],
        );
    });
    const stat = vi.fn(async (uri: { path: string }) => {
        const segs = uri.path.split('/').filter(Boolean);
        let node: unknown = tree;
        for (let i = 0; i < segs.length - 1; i++) {
            node = (node as Record<string, unknown>)?.[segs[i]];
        }
        const last = segs[segs.length - 1];
        const entry = (node as Record<string, unknown> | undefined)?.[last];
        if (entry === undefined || entry === 'dir') {
            throw new Error('ENOENT');
        }
        return { type: FileType.File };
    });
    return { listDir, stat };
}

describe('naturalCompare', () => {
    it('compares digit runs numerically (9 before 10)', () => {
        expect(naturalCompare('9', '10')).toBeLessThan(0);
        expect(naturalCompare('10', '9')).toBeGreaterThan(0);
    });

    it('orders digits before letters (42 before common)', () => {
        expect(naturalCompare('42', 'common')).toBeLessThan(0);
    });

    it('falls back to alphabetical order for words', () => {
        expect(naturalCompare('common', 'dev')).toBeLessThan(0);
    });

    it('treats identical names as equal', () => {
        expect(naturalCompare('42', '42')).toBe(0);
    });
});

describe('resolveModFolderIcon', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the first qualifying branch icon (42 without icon, common with)', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                '42': { 'mod.info': 'file' },
                common: { 'mod.info': 'file', 'icon.png': 'file' },
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon?.path).toBe('/ee/common/icon.png');
    });

    it('stops scanning at the first branch with mod.info and icon.png', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                '42': { 'mod.info': 'file', 'icon.png': 'file' },
                common: { 'mod.info': 'file', 'icon.png': 'file' },
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon?.path).toBe('/ee/42/icon.png');
        const iconStatCalls = stat.mock.calls.filter((c) =>
            String(c[0].path).endsWith(MOD_BRANCH_ICON_FILE),
        );
        expect(iconStatCalls).toHaveLength(1);
    });

    it('skips subfolders without mod.info even when they have icon.png', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                docs: { 'icon.png': 'file' } as Record<
                    string,
                    'file' | 'dir' | undefined
                >,
                common: { 'mod.info': 'file', 'icon.png': 'file' },
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon?.path).toBe('/ee/common/icon.png');
    });

    it('returns undefined when no branch has mod.info', async () => {
        const { listDir, stat } = makeFs({
            ee: { random: { 'icon.png': 'file' } },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon).toBeUndefined();
    });

    it('returns undefined when valid branches carry no icon.png', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                '42': { 'mod.info': 'file' },
                common: { 'mod.info': 'file' },
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon).toBeUndefined();
    });

    it('returns undefined when the mod folder is unreadable', async () => {
        const listDir = vi.fn(async () => {
            throw new Error('ENOENT');
        });
        const stat = vi.fn(async () => ({ type: FileType.File }));
        const icon = await resolveModFolderIcon(asUri('gone'), listDir, stat);
        expect(icon).toBeUndefined();
    });

    it('ignores dot-prefixed folders', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                '.git': { 'mod.info': 'file', 'icon.png': 'file' } as Record<
                    string,
                    'file' | 'dir' | undefined
                >,
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon).toBeUndefined();
    });

    it('scans in numeric-alphabetical order (9 before 10)', async () => {
        const { listDir, stat } = makeFs({
            ee: {
                '10': { 'mod.info': 'file', 'icon.png': 'file' },
                '9': { 'mod.info': 'file', 'icon.png': 'file' },
            },
        });
        const icon = await resolveModFolderIcon(asUri('ee'), listDir, stat);
        expect(icon?.path).toBe('/ee/9/icon.png');
    });
});

describe('directory children ordering', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('lists folders before files, each in natural order', async () => {
        vscodeMock.workspace.fs.readDirectory = vi.fn(
            async () =>
                [
                    ['icon.png', FileType.File],
                    ['media', FileType.Directory],
                    ['10', FileType.Directory],
                    ['9', FileType.Directory],
                    ['readme.md', FileType.File],
                ] as Entry[],
        );

        const provider = new ProjectExplorerProvider(asUri('ext'));
        const children = await provider.getChildren({
            kind: 'directory',
            uri: asUri('ee42'),
            projectDir: asUri('proj'),
            label: '42',
            collapsible: 0,
        });

        expect(children.map((c) => c.label)).toEqual([
            '9',
            '10',
            'media',
            'icon.png',
            'readme.md',
        ]);
    });
});

describe('constants and manifest', () => {
    const EXT_ROOT = path.resolve(__dirname, '../../packages/vscode-extension');
    const PKG = JSON.parse(
        fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'),
    );
    const NLS_EN = JSON.parse(
        fs.readFileSync(path.join(EXT_ROOT, 'package.nls.json'), 'utf8'),
    );
    const NLS_VI = JSON.parse(
        fs.readFileSync(path.join(EXT_ROOT, 'package.nls.vi.json'), 'utf8'),
    );

    /** Resolves a %key% NLS reference against the English table. */
    const nls = (value: string): string =>
        value.startsWith('%') && value.endsWith('%')
            ? (NLS_EN[value.slice(1, -1)] as string)
            : value;

    it('project folder icons point at bundled theme variants', () => {
        expect(PROJECT_FOLDER_ICON_LIGHT).toBe(
            'resources/icons/pzstudio-project-explorer-light.svg',
        );
        expect(PROJECT_FOLDER_ICON_DARK).toBe(
            'resources/icons/pzstudio-project-explorer-dark.svg',
        );
        expect(
            fs.existsSync(path.join(EXT_ROOT, PROJECT_FOLDER_ICON_LIGHT)),
        ).toBe(true);
        expect(
            fs.existsSync(path.join(EXT_ROOT, PROJECT_FOLDER_ICON_DARK)),
        ).toBe(true);
    });

    it('tree-rendered SVGs use explicit colors, not currentColor', () => {
        // Tree rows and inline buttons render file icons as-is with no CSS
        // color context, where currentColor resolves to black. Only the
        // Activity Bar icon (theme-masked) may rely on currentColor.
        for (const svg of [
            PROJECT_FOLDER_ICON_LIGHT,
            PROJECT_FOLDER_ICON_DARK,
            'resources/icons/beaker-dim.svg',
        ]) {
            const content = fs.readFileSync(path.join(EXT_ROOT, svg), 'utf8');
            expect(content).not.toContain('currentColor');
        }
        const activityBar = fs.readFileSync(
            path.join(EXT_ROOT, 'resources/icons/pzstudio-icon.svg'),
            'utf8',
        );
        expect(activityBar).toContain('currentColor');
    });

    it('uses file names expected from the tree scan', () => {
        expect(MOD_BRANCH_INFO_FILE).toBe('mod.info');
        expect(MOD_BRANCH_ICON_FILE).toBe('icon.png');
    });

    it('displayName is PZ Studio (resolved through NLS)', () => {
        expect(nls(PKG.displayName)).toBe('PZ Studio');
    });

    it('every %key% in the manifest resolves in en and vi NLS tables', () => {
        const keys = (JSON.stringify(PKG).match(/"%[^"]+%"/g) || []).map((m) =>
            m.slice(2, -2),
        );
        expect(keys.length).toBeGreaterThan(30);
        for (const key of keys) {
            expect(NLS_EN[key], `missing en key: ${key}`).toBeDefined();
            expect(NLS_VI[key], `missing vi key: ${key}`).toBeDefined();
        }
    });

    it('l10n bundles share the same key set across every locale', () => {
        const bundleDir = path.join(EXT_ROOT, 'l10n');
        const bundleFiles = fs
            .readdirSync(bundleDir)
            .filter((f) => /^bundle\.l10n(\..+)?\.json$/.test(f));
        // 25 PZ game languages: unsuffixed en + 24 locale files.
        expect(bundleFiles.length).toBe(25);

        const enKeys = Object.keys(
            JSON.parse(
                fs.readFileSync(
                    path.join(bundleDir, 'bundle.l10n.json'),
                    'utf8',
                ),
            ),
        ).sort();
        for (const file of bundleFiles) {
            const parsed = JSON.parse(
                fs.readFileSync(path.join(bundleDir, file), 'utf8'),
            );
            expect(Object.keys(parsed).sort(), file).toEqual(enKeys);
        }
    });

    it('nls tables share the same key set across every locale', () => {
        const extFiles = fs.readdirSync(EXT_ROOT);
        const nlsFiles = extFiles.filter((f) =>
            /^package\.nls(\..+)?\.json$/.test(f),
        );
        expect(nlsFiles.length).toBe(25);

        const enKeys = Object.keys(NLS_EN).sort();
        for (const file of nlsFiles) {
            const parsed = JSON.parse(
                fs.readFileSync(path.join(EXT_ROOT, file), 'utf8'),
            );
            expect(Object.keys(parsed).sort(), file).toEqual(enKeys);
        }
    });

    it('Activity Bar icon uses resources/icons and exists on disk', () => {
        const icon = PKG.contributes.viewsContainers.activitybar[0].icon;
        expect(icon).toBe('resources/icons/pzstudio-icon.svg');
        expect(fs.existsSync(path.join(EXT_ROOT, icon))).toBe(true);
    });

    it('manifest no longer references the removed media/ folder', () => {
        expect(
            PKG.contributes.viewsContainers.activitybar[0].icon,
        ).not.toContain('media/');
        const view = PKG.contributes.views['pzstudio-container'][0];
        expect(view.icon).not.toContain('media/');
        const dimCommand = PKG.contributes.commands.find(
            (c: { command: string }) => c.command === 'pzstudio.modDevOnly.dim',
        );
        expect(dimCommand.icon).toBe('resources/icons/beaker-dim.svg');
    });

    it('build command ID is preserved', () => {
        const cmd = PKG.contributes.commands.find(
            (c: { command: string }) => c.command === 'pzstudio.build',
        );
        expect(cmd).toBeDefined();
    });

    it('exposes eye/eye-closed toggle pair driven by the context key', () => {
        const titleMenu = PKG.contributes.menus['view/title'];
        const showAll = titleMenu.find(
            (m: { command: string }) =>
                m.command === 'pzstudio.explorer.toggleFiles',
        );
        const showEssential = titleMenu.find(
            (m: { command: string }) =>
                m.command === 'pzstudio.explorer.toggleFiles.hidden',
        );
        expect(showAll.when).toBe(
            `view == pzstudio.projectExplorer && ${SHOW_ALL_FILES_CONTEXT_KEY}`,
        );
        expect(showEssential.when).toBe(
            `view == pzstudio.projectExplorer && !${SHOW_ALL_FILES_CONTEXT_KEY}`,
        );

        const commands = PKG.contributes.commands;
        expect(
            commands.find(
                (c: { command: string }) =>
                    c.command === 'pzstudio.explorer.toggleFiles',
            ).icon,
        ).toBe('$(eye)');
        expect(
            commands.find(
                (c: { command: string }) =>
                    c.command === 'pzstudio.explorer.toggleFiles.hidden',
            ).icon,
        ).toBe('$(eye-closed)');

        const palette = PKG.contributes.menus.commandPalette;
        expect(
            palette.some(
                (p: { command: string; when?: string }) =>
                    p.command === 'pzstudio.explorer.toggleFiles.hidden' &&
                    p.when === 'false',
            ),
        ).toBe(true);
    });

    it('keeps explorer-only commands out of the command palette', () => {
        // The entries must live under menus.commandPalette: a top-level
        // contributes.commandPalette key is silently ignored by VS Code
        // (the f4122cf nesting bug every later edit preserved).
        const palette: Array<{ command: string; when?: string }> =
            PKG.contributes.menus.commandPalette;
        expect(
            Array.isArray(palette) && palette.length > 0,
            'menus.commandPalette must exist and hold the hidden entries',
        ).toBe(true);
        expect(PKG.contributes.commandPalette).toBeUndefined();

        // Tree/title-bar actions stay reachable from the explorer itself;
        // they must not clutter the palette or keyboard-shortcut search.
        const hidden = [
            'pzstudio.modConfigure',
            'pzstudio.explorer.refresh',
            'pzstudio.explorer.toggleFiles',
            'pzstudio.explorer.toggleFiles.hidden',
            'pzstudio.modIncluded',
            'pzstudio.modExcluded',
            'pzstudio.modDevOnly',
            'pzstudio.modDevOnly.dim',
        ];
        for (const id of hidden) {
            expect(
                palette.some((p) => p.command === id && p.when === 'false'),
                `${id} must be hidden from the command palette`,
            ).toBe(true);
        }

        // The core workflow commands stay palette-visible (watch = the
        // sync toggle, doctor = the diagnostics entry point).
        const visible = [
            'pzstudio.new',
            'pzstudio.newHere',
            'pzstudio.add',
            'pzstudio.build',
            'pzstudio.clean',
            'pzstudio.delete',
            'pzstudio.lang',
            'pzstudio.rename',
            'pzstudio.update',
            'pzstudio.modinfoGenerate',
            'pzstudio.watch',
            'pzstudio.doctor',
        ];
        for (const id of visible) {
            expect(
                PKG.contributes.commands.some(
                    (c: { command: string }) => c.command === id,
                ),
                `${id} must remain a contributed command`,
            ).toBe(true);
            expect(
                palette.some((p) => p.command === id && p.when === 'false'),
                `${id} must stay palette-visible`,
            ).toBe(false);
        }
    });

    // UX-13: a mod declared in project.json but absent on disk renders as
    // 'mod-missing'. The row must be clearly identifiable AND must not offer
    // normal-mod actions (Configure/Generate/Rename/Delete) — its approved
    // lean v1 remediation is Open project.json + Refresh, exactly the two
    // commands the manifest exposes for it. These tests simulate the
    // manifest's view/item/context when-clauses per contextValue, matching
    // which menu entries VS Code would actually show.
    describe('missing-mod context menu (UX-13)', () => {
        const MENUS = PKG.contributes.menus['view/item/context'] as Array<{
            command: string;
            when?: string;
            group?: string;
        }>;

        /**
         * Evaluator for the when-clause forms used in view/item/context:
         * parens-joined OR groups, `&&`, and the atoms
         * `view == pzstudio.projectExplorer`, `viewItem == <value>` and
         * `viewItem =~ /regex/`. Unknown atoms (context keys the tree never
         * publishes here) count as false so a future entry enabled by an
         * unmatched key fails loudly in tests, not silently.
         */
        function menuVisible(when: string, viewItem: string): boolean {
            // Pull out `=~ /regex/` atoms first: their body may contain
            // `|`, `&&` and other operator characters.
            const regexes: RegExp[] = [];
            const prepared = when.replace(
                /viewItem\s*=~\s*\/([^/]*)\/[a-z]*/g,
                (_matter: string, body: string) =>
                    `@r${regexes.push(new RegExp(body)) - 1}@`,
            );
            const tokens = prepared
                .replace(/\(/g, ' ( ')
                .replace(/\)/g, ' ) ')
                .split(/\s+/);

            let pos = 0;
            const peek = (): string | undefined => tokens[pos];
            const take = (): string | undefined => tokens[pos++];
            const parseAtom = (): boolean => {
                const tok = take();
                if (tok === undefined) {
                    return false;
                }
                if (tok === '(') {
                    const value = parseOr();
                    take(); // ')'
                    return value;
                }
                if (tok.startsWith('@r')) {
                    return regexes[Number(tok.slice(2, tok.length - 1))].test(
                        viewItem,
                    );
                }
                if (tok === 'viewItem') {
                    const op = take();
                    const value = take() ?? '';
                    if (op !== '==') {
                        // Unhandled comparison (never used in these menus).
                        return false;
                    }
                    return viewItem === value;
                }
                if (tok === 'view') {
                    take(); // '=='
                    take(); // 'pzstudio.projectExplorer'
                    return true;
                }
                // Anything else (context keys, negations) is not part of the
                // missing-mod surface — treat as not matching.
                return false;
            };
            const parseAndGroup = (): boolean => {
                let value = parseAtom();
                while (peek() === '&&') {
                    pos++;
                    value = parseAtom() && value;
                }
                return value;
            };
            const parseOr = (): boolean => {
                let value = parseAndGroup();
                while (peek() === '||') {
                    pos++;
                    const other = parseAndGroup();
                    value = other || value;
                }
                return value;
            };
            return parseOr();
        }

        const commandsFor = (viewItem: string) =>
            MENUS.filter((entry) =>
                menuVisible(entry.when ?? '', viewItem),
            ).map((entry) => entry.command);

        it('offers only the lean remediation actions on missing-mod rows', () => {
            expect(commandsFor('mod-missing').sort()).toEqual([
                'pzstudio.explorer.refresh',
                'pzstudio.openProjectJson',
            ]);
        });

        it('offers no inline buttons on missing-mod rows', () => {
            const inline = MENUS.filter(
                (entry) =>
                    (entry.group ?? '').startsWith('inline') &&
                    menuVisible(entry.when ?? '', 'mod-missing'),
            );
            expect(inline).toEqual([]);
        });

        it('does not leak a destructive or remove action onto missing rows', () => {
            // The approved v1 remediation has no "Remove from Project": a
            // delete on a missing folder is today's destructive `mod delete`
            // flow, not an entry removal (Q4 is still open).
            for (const entry of MENUS) {
                if (menuVisible(entry.when ?? '', 'mod-missing')) {
                    expect(entry.command).toMatch(
                        /^(pzstudio\.openProjectJson|pzstudio\.explorer\.refresh)$/,
                    );
                }
            }
        });

        it('keeps the normal-mod actions on concrete-state rows', () => {
            // State toggles stay per-state (the manifest's existing pairs);
            // all four rows' edits/actions apply to every concrete state.
            const expected: Record<string, string[]> = {
                'mod-included': [
                    'pzstudio.modIncluded',
                    'pzstudio.modDevOnly.dim',
                ],
                'mod-devonly': ['pzstudio.modIncluded', 'pzstudio.modDevOnly'],
                'mod-excluded': [
                    'pzstudio.modExcluded',
                    'pzstudio.modDevOnly.dim',
                ],
            };
            for (const [viewItem, toggles] of Object.entries(expected)) {
                const visible = commandsFor(viewItem);
                for (const id of [
                    ...toggles,
                    'pzstudio.modinfoGenerate',
                    'pzstudio.rename',
                    'pzstudio.delete',
                    'pzstudio.modConfigure',
                ]) {
                    expect(visible, `${viewItem} must keep ${id}`).toContain(
                        id,
                    );
                }
            }
        });

        it('renders missing-mod rows identifiable and free of state buttons', () => {
            const provider = new ProjectExplorerProvider(asUri('ext'));
            const item = provider.getTreeItem({
                kind: 'missing-mod',
                uri: asUri('proj/ghost'),
                projectDir: asUri('proj'),
                label: 'ghost',
                collapsible: 0,
                modId: 'ghost',
                description: 'missing on disk',
            } as never);
            expect(item.contextValue).toBe('mod-missing');
            expect(item.description).toBe('missing on disk');
            expect((item.iconPath as unknown as { id: string }).id).toBe(
                'warning',
            );
        });
    });
});

describe('project diagnostics badge', () => {
    const PROJECT_JSON = JSON.stringify({
        workshop: { id: 12345, title: 'Test Title' },
        mods: {},
    });

    /** Workspace with one root project discoverable by the scan. */
    function seedProjectNode() {
        vscodeMock.workspace.workspaceFolders = [
            { uri: asUri('ws'), name: 'ws' },
        ] as never;
        vscodeMock.workspace.fs.stat = vi.fn(async (uri: { path: string }) => {
            if (uri.path.endsWith('/project.json')) {
                return { type: FileType.File };
            }
            throw new Error('ENOENT');
        });
        vscodeMock.workspace.fs.readDirectory = vi.fn(
            async () => [] as Entry[],
        );
        vscodeMock.workspace.fs.readFile = vi.fn(
            async (uri: { path: string }) => {
                if (uri.path.endsWith('/project.json')) {
                    return new TextEncoder().encode(PROJECT_JSON);
                }
                throw new Error('ENOENT');
            },
        );
    }

    it('appends error/warning counts to the row and findings to the tooltip', async () => {
        seedProjectNode();
        const source = vi.fn(async () => ({
            errors: 1,
            warnings: 2,
            infos: 1,
            report: {
                projectDir: '/ws',
                diagnostics: [
                    {
                        severity: 'error',
                        module: 'mods',
                        code: 'mods.missing',
                        message:
                            "Mod folder 'ghost' is declared in project.json but missing on disk.",
                    },
                    {
                        severity: 'warning',
                        module: 'project',
                        code: 'project.noDescription',
                        message: 'workshop/description.txt is missing.',
                    },
                    {
                        severity: 'warning',
                        module: 'filesystem',
                        code: 'filesystem.outDirMissing',
                        message:
                            'The build output directory does not exist yet.',
                    },
                    {
                        severity: 'info',
                        module: 'templates',
                        code: 'templates.notCached',
                        message: 'The template cache is not downloaded yet.',
                    },
                ],
            },
        }));
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const nodes = await provider.getChildren();

        expect(nodes).toHaveLength(1);
        expect(nodes[0].description).toBe('id 12345 · Test Title · ✗ 1 ⚠ 2');
        expect(nodes[0].tooltip).toContain(
            "[mods] Mod folder 'ghost' is declared",
        );
        expect(nodes[0].tooltip).toContain('[templates]');
    });

    it('leaves clean project rows unannotated', async () => {
        seedProjectNode();
        const source = vi.fn(async () => ({
            errors: 0,
            warnings: 0,
            infos: 0,
            report: { projectDir: '/ws', diagnostics: [] },
        }));
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const nodes = await provider.getChildren();

        expect(nodes[0].description).toBe('id 12345 · Test Title');
        expect(nodes[0].tooltip).toBeUndefined();
    });

    it('skips diagnostics entirely when no source is wired', async () => {
        seedProjectNode();
        const provider = new ProjectExplorerProvider(asUri('ext'));

        const nodes = await provider.getChildren();

        expect(nodes[0].description).toBe('id 12345 · Test Title');
        expect(nodes[0].tooltip).toBeUndefined();
    });
});

// ── UX-07: bounded diagnostics cache ────────────────────────────────────────
//
// The explorer badge must not re-run the full doctor engine on every tree
// render. These tests count actual diagnostics-source executions (never
// getChildren calls) and use deterministic controllable promises — no
// wall-clock sleeps prove coalescing or invalidation ordering.

describe('project diagnostics cache (UX-07)', () => {
    interface Summary {
        errors: number;
        warnings: number;
        infos: number;
        report: {
            projectDir: string;
            diagnostics: Array<{
                severity: string;
                module: string;
                code: string;
                message: string;
            }>;
        };
    }

    const clean = (): Summary => ({
        errors: 0,
        warnings: 0,
        infos: 0,
        report: { projectDir: '', diagnostics: [] },
    });
    const withIssues = (
        errors: number,
        warnings: number,
        message: string,
    ): Summary => ({
        errors,
        warnings,
        infos: 0,
        report: {
            projectDir: '',
            diagnostics: [
                {
                    severity: 'error',
                    module: 'mods',
                    code: 'mods.missing',
                    message,
                },
            ],
        },
    });

    function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }

    /**
     * Deterministic microtask pump: runs pending continuations until the
     * source has been invoked at least `minCalls` times. Proves ordering
     * without timers or sleeps.
     */
    async function untilCalled(
        fn: { mock: { calls: unknown[] } },
        minCalls = 1,
        max = 500,
    ): Promise<void> {
        for (let i = 0; i < max && fn.mock.calls.length < minCalls; i++) {
            await Promise.resolve();
        }
        if (fn.mock.calls.length < minCalls) {
            throw new Error(
                `the diagnostics source was never called ${minCalls} time(s)`,
            );
        }
    }

    /**
     * Multi-project workspace fixture: depth-1 projects under one root,
     * with controllable project.json content, mtime stamps and discovery.
     */
    function seedWorkspace() {
        const listed = new Set<string>();
        const contents = new Map<string, string>();
        const stamps = new Map<string, { mtime: number; size: number }>();
        const pjOf = (dir: string) => `/ws/${dir}/project.json`;

        vscodeMock.workspace.workspaceFolders = [
            { uri: asUri('ws'), name: 'ws' },
        ] as never;
        vscodeMock.workspace.fs.stat = vi.fn(async (uri: { path: string }) => {
            const stamp = stamps.get(uri.path);
            if (stamp) {
                return { type: FileType.File, ctime: 0, ...stamp };
            }
            throw new Error('ENOENT');
        });
        vscodeMock.workspace.fs.readDirectory = vi.fn(
            async (uri: { path: string }) => {
                if (uri.path === '/ws') {
                    return [...listed].map(
                        (name): Entry => [name, FileType.Directory],
                    );
                }
                return [] as Entry[];
            },
        );
        vscodeMock.workspace.fs.readFile = vi.fn(
            async (uri: { path: string }) => {
                const content = contents.get(uri.path);
                if (content !== undefined) {
                    return new TextEncoder().encode(content);
                }
                throw new Error('ENOENT');
            },
        );

        return {
            /** Adds a project to discovery with project.json content + mtime. */
            addProject(dir: string, content: string, mtime = 1): void {
                listed.add(dir);
                contents.set(pjOf(dir), content);
                stamps.set(pjOf(dir), { mtime, size: content.length });
            },
            /** Removes the project from discovery and the filesystem. */
            removeProject(dir: string): void {
                listed.delete(dir);
                contents.delete(pjOf(dir));
                stamps.delete(pjOf(dir));
            },
            /** A meaningful change: new content under a newer mtime. */
            rewriteProject(dir: string, content: string, mtime: number): void {
                contents.set(pjOf(dir), content);
                stamps.set(pjOf(dir), { mtime, size: content.length });
            },
        };
    }

    const PROJECT_A_V1 = JSON.stringify({
        workshop: { id: 1, title: 'Project A' },
        mods: {},
    });
    const PROJECT_A_V2 = JSON.stringify({
        workshop: { id: 1, title: 'Project A' },
        mods: {},
        excludes: ['old_mod'],
    });
    const PROJECT_B = JSON.stringify({
        workshop: { id: 2, title: 'Project B' },
        mods: {},
    });

    it('reuses the cached diagnostics across unchanged renders', async () => {
        const seed = seedWorkspace();
        seed.addProject('A', PROJECT_A_V1);
        const source = vi.fn(async () => withIssues(1, 2, 'first finding'));
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const first = await provider.getChildren();
        expect(source).toHaveBeenCalledTimes(1);
        expect(first[0].description).toBe('id 1 · Project A · ✗ 1 ⚠ 2');

        // Presentation refresh: rebuild the rows, reuse the diagnostics.
        provider.refresh();
        const second = await provider.getChildren();

        expect(source).toHaveBeenCalledTimes(1);
        expect(second).toEqual(first);
        expect(second[0].tooltip).toContain('[mods] first finding');
    });

    it('re-renders several projects without any doctor run when nothing changed', async () => {
        const seed = seedWorkspace();
        seed.addProject('A', PROJECT_A_V1);
        seed.addProject('B', PROJECT_B);
        seed.addProject('C', PROJECT_B);
        const source = vi.fn(async () => clean());
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const first = await provider.getChildren();
        expect(source).toHaveBeenCalledTimes(3);
        expect(first).toHaveLength(3);

        provider.refresh();
        const second = await provider.getChildren();

        // 3 projects × 2 unchanged renders → still exactly 3 doctor runs.
        expect(source).toHaveBeenCalledTimes(3);
        expect(second).toEqual(first);

        // Expanding project children mirrors the filesystem only — the
        // diagnostics source must stay cold there too.
        await provider.getChildren(second[0]);
        expect(source).toHaveBeenCalledTimes(3);
    });

    it('recomputes only the project whose project.json changed', async () => {
        const seed = seedWorkspace();
        seed.addProject('A', PROJECT_A_V1);
        seed.addProject('B', PROJECT_B);
        const summaries = new Map<string, Summary>([
            ['/ws/A', clean()],
            ['/ws/B', withIssues(0, 1, 'b warning')],
        ]);
        const source = vi.fn(
            async (dir: { path: string }) => summaries.get(dir.path) ?? clean(),
        );
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const first = await provider.getChildren();
        expect(source).toHaveBeenCalledTimes(2);
        expect(first[0].description).toBe('id 1 · Project A');
        expect(first[1].description).toBe('id 2 · Project B · ⚠ 1');

        // Only project A changes on disk (project.json rewritten).
        summaries.set('/ws/A', withIssues(2, 0, 'a missing mods'));
        seed.rewriteProject('A', PROJECT_A_V2, 2);

        provider.refresh();
        const second = await provider.getChildren();

        // Exactly one recompute: A again — never B.
        expect(
            source.mock.calls.map((c) => (c[0] as { path: string }).path),
        ).toEqual(['/ws/A', '/ws/B', '/ws/A']);
        expect(second[0].description).toBe('id 1 · Project A · ✗ 2');
        expect(second[1].description).toBe('id 2 · Project B · ⚠ 1');
    });

    it('reuses the cache across debounced watcher/command refreshes', async () => {
        vi.useFakeTimers();
        try {
            const seed = seedWorkspace();
            seed.addProject('A', PROJECT_A_V1);
            const source = vi.fn(async () => clean());
            const provider = new ProjectExplorerProvider(
                asUri('ext'),
                source as never,
            );

            await provider.getChildren();
            expect(source).toHaveBeenCalledTimes(1);

            // The watcher/runner path: debounced presentation refresh.
            provider.requestRefresh();
            vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);

            await provider.getChildren();
            expect(source).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('coalesces concurrent renders into one doctor run per project', async () => {
        const seed = seedWorkspace();
        seed.addProject('A', PROJECT_A_V1);
        const gate = deferred<Summary>();
        const source = vi.fn(() => gate.promise);
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const first = provider.getChildren();
        const second = provider.getChildren();
        await untilCalled(source);

        // Both renders are pending on the same project: one execution.
        expect(source).toHaveBeenCalledTimes(1);

        gate.resolve(withIssues(1, 0, 'shared finding'));
        const [nodes1, nodes2] = await Promise.all([first, second]);

        expect(source).toHaveBeenCalledTimes(1);
        expect(nodes1[0].description).toBe('id 1 · Project A · ✗ 1');
        expect(nodes2[0].description).toBe(nodes1[0].description);
    });

    it('drops an in-flight result that became stale instead of caching it', async () => {
        const seed = seedWorkspace();
        seed.addProject('A', PROJECT_A_V1);
        const oldResult = deferred<Summary>();
        const newResult = deferred<Summary>();
        const queue = [oldResult.promise, newResult.promise];
        const source = vi.fn(() => queue.shift()!);
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const first = provider.getChildren();
        await untilCalled(source);

        // The project changes while the doctor run is in flight.
        seed.rewriteProject('A', PROJECT_A_V2, 2);
        oldResult.resolve(withIssues(9, 9, 'stale pre-change finding'));
        const nodes1 = await first;
        expect(nodes1[0].description).toBe('id 1 · Project A · ✗ 9 ⚠ 9');

        // The next render must recompute, not resurrect the stale result…
        const second = provider.getChildren();
        await untilCalled(source, 2);
        expect(source).toHaveBeenCalledTimes(2);
        newResult.resolve(withIssues(1, 0, 'fresh finding'));
        const nodes2 = await second;
        expect(nodes2[0].description).toBe('id 1 · Project A · ✗ 1');

        // …and the fresh result then holds the cache (no more recomputes).
        provider.refresh();
        await provider.getChildren();
        expect(source).toHaveBeenCalledTimes(2);
    });

    it('a render joining a stale in-flight run still yields a fresh recompute', async () => {
        const seed = seedWorkspace();
        seed.addProject('A', PROJECT_A_V1);
        const gate = deferred<Summary>();
        const lateResult = deferred<Summary>();
        const queue = [gate.promise, lateResult.promise];
        const source = vi.fn(() => queue.shift()!);
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const first = provider.getChildren();
        await untilCalled(source);

        // The project changes while the first run is still in flight; the
        // second render observes the newer fingerprint and joins the only
        // in-flight execution (coalescing) instead of starting a second one.
        seed.rewriteProject('A', PROJECT_A_V2, 2);
        const second = provider.getChildren();
        for (let i = 0; i < 20; i++) await Promise.resolve();
        gate.resolve(withIssues(9, 9, 'stale pre-change finding'));

        const [nodes1, nodes2] = await Promise.all([first, second]);
        expect(source).toHaveBeenCalledTimes(1);
        expect(nodes2[0].description).toBe(nodes1[0].description);

        // The joined (stale) result must not hold the cache for the newer
        // project state: the next render recomputes fresh.
        const third = provider.getChildren();
        await untilCalled(source, 2);
        expect(source).toHaveBeenCalledTimes(2);
        lateResult.resolve(withIssues(1, 0, 'fresh finding'));
        const nodes3 = await third;
        expect(nodes3[0].description).toBe('id 1 · Project A · ✗ 1');
    });

    it('never caches a failed doctor run and lets the next render retry', async () => {
        const seed = seedWorkspace();
        seed.addProject('A', PROJECT_A_V1);
        const source = vi
            .fn<() => Promise<Summary>>()
            .mockRejectedValueOnce(new Error('engine boom'))
            .mockResolvedValueOnce(withIssues(1, 0, 'recovered finding'));
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        // First render: the failure is decoration — the tree still renders.
        const failed = await provider.getChildren();
        expect(failed).toHaveLength(1);
        expect(failed[0].description).toBe('id 1 · Project A');
        expect(failed[0].tooltip).toBeUndefined();
        expect(source).toHaveBeenCalledTimes(1);

        // A later render retries the run and recovers the badge.
        const recovered = await provider.getChildren();
        expect(source).toHaveBeenCalledTimes(2);
        expect(recovered[0].description).toBe('id 1 · Project A · ✗ 1');

        // The recovered result is then cached as usual.
        provider.refresh();
        await provider.getChildren();
        expect(source).toHaveBeenCalledTimes(2);
    });

    it('recomputes diagnostics on the explicit refresh path', async () => {
        const seed = seedWorkspace();
        seed.addProject('A', PROJECT_A_V1);
        const results = [clean(), withIssues(1, 0, 'fresh state finding')];
        const source = vi.fn(async () => results.shift() ?? clean());
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const first = await provider.getChildren();
        expect(first[0].description).toBe('id 1 · Project A');

        // The title-bar Refresh command: explicit diagnostic rescan.
        provider.refresh({ invalidateDiagnostics: true });
        const second = await provider.getChildren();

        expect(source).toHaveBeenCalledTimes(2);
        expect(second[0].description).toBe('id 1 · Project A · ✗ 1');
    });

    it('evicts the cache entry of a removed project; rediscovery recomputes', async () => {
        const seed = seedWorkspace();
        seed.addProject('A', PROJECT_A_V1);
        const results = [
            withIssues(1, 0, 'first discovery finding'),
            withIssues(2, 0, 'rediscovered finding'),
        ];
        const source = vi.fn(async () => results.shift() ?? clean());
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const first = await provider.getChildren();
        expect(source).toHaveBeenCalledTimes(1);
        expect(first[0].description).toBe('id 1 · Project A · ✗ 1');

        // The project disappears (folder deleted / project.json removed).
        seed.removeProject('A');
        const gone = await provider.getChildren();
        expect(gone).toHaveLength(1);
        expect(gone[0].kind).toBe('placeholder');
        expect(source).toHaveBeenCalledTimes(1);

        // Rediscovered with the SAME project.json state as before: the
        // eviction — not the fingerprint — must force the fresh run.
        seed.addProject('A', PROJECT_A_V1, 1);
        const again = await provider.getChildren();

        expect(source).toHaveBeenCalledTimes(2);
        expect(again[0].description).toBe('id 1 · Project A · ✗ 2');
    });

    it('disposing the provider drops the diagnostics cache', async () => {
        const seed = seedWorkspace();
        seed.addProject('A', PROJECT_A_V1);
        const results = [
            withIssues(1, 0, 'before dispose'),
            withIssues(2, 0, 'after dispose'),
        ];
        const source = vi.fn(async () => results.shift() ?? clean());
        const provider = new ProjectExplorerProvider(
            asUri('ext'),
            source as never,
        );

        const before = await provider.getChildren();
        expect(source).toHaveBeenCalledTimes(1);
        expect(before[0].description).toBe('id 1 · Project A · ✗ 1');

        provider.dispose();
        const after = await provider.getChildren();

        expect(source).toHaveBeenCalledTimes(2);
        expect(after[0].description).toBe('id 1 · Project A · ✗ 2');
    });
});
