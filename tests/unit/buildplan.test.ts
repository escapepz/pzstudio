import { describe, it, expect } from 'vitest';
import {
    FileOperation,
    PlanBuildInput,
    collectIncludedModIds,
    planBuild,
    resolveBuildOutputPath,
    sanitizeFolderName,
} from '../../src/lib/core/buildplan';
import type { IProjectConfig } from '../../src/lib/project';

const baseConfig = {
    workshop: {
        id: 12345,
        title: 'Test Project',
        visibility: 'public',
        tags: ['Build 42'],
    },
    mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
    excludes: [],
    outdir: '/out',
} as unknown as IProjectConfig;

function baseInput(overrides: Partial<PlanBuildInput> = {}): PlanBuildInput {
    return {
        config: JSON.parse(JSON.stringify(baseConfig)),
        variant: 'main',
        workshopTemplateDir: '/templates/workshop',
        projectDir: '/proj',
        modSourceStates: {
            my_mod: { branchFolders: [], modInfoExists: {} },
        },
        descriptionLines: [],
        previewPngExists: true,
        ...overrides,
    };
}

function modInfoWrites(operations: FileOperation[]) {
    return operations.filter(
        (op) => op.type === 'writeFile' && op.path.endsWith('mod.info'),
    ) as Extract<FileOperation, { type: 'writeFile' }>[];
}

describe('planBuild (pure)', () => {
    it('should reset the output directory and copy the workshop template first', () => {
        const operations = planBuild(baseInput());

        expect(operations[0]).toEqual({
            type: 'removeDir',
            path: '/out/Test Project',
        });
        expect(operations[1]).toEqual({
            type: 'makeDir',
            path: '/out/Test Project',
        });
        expect(operations[2]).toEqual({
            type: 'log',
            level: 'info',
            message: `- Copying workshop template...`,
        });
        expect(operations[3]).toEqual({
            type: 'copyTree',
            from: '/templates/workshop',
            to: '/out/Test Project',
            excludeIgnoreFile: true,
            ignoreDotFiles: true,
        });
    });

    it('should copy included mods with the excludes as ignore items', () => {
        const operations = planBuild(baseInput());
        const copy = operations.find(
            (op) =>
                op.type === 'copyTree' && (op as any).from === '/proj/my_mod',
        ) as any;

        expect(copy.from).toBe('/proj/my_mod');
        expect(copy.to).toBe('/out/Test Project/Contents/mods/my_mod');
        expect(copy.excludeIgnoreFile).toBe(true);
        expect(copy.ignoreDotFiles).toBe(true);
        expect(copy.ignoreItems).toEqual([]);
    });

    it('should skip excluded mods entirely', () => {
        const config = baseInput().config;
        config.mods.other_mod = { name: 'Other' } as any;
        config.excludes = ['other_mod'];

        const operations = planBuild(baseInput({ config }));

        const copyTrees = operations.filter(
            (op) => op.type === 'copyTree',
        ) as any[];
        // workshop template + the included mod only
        expect(copyTrees).toHaveLength(2);
        expect(
            copyTrees.find((op) => op.from === '/proj/other_mod'),
        ).toBeUndefined();
        const logs = operations
            .filter((op) => op.type === 'log')
            .map((op) => (op as any).message);
        expect(logs.join('\n')).not.toContain('other_mod');
    });

    it('should skip dev-only mods in the main variant but keep them in development', () => {
        const config = baseInput().config;
        config.mods.dev_mod = {
            name: 'Dev Mod',
            description: 'Dev only.',
            build: { devOnly: true },
        } as any;

        const mainOperations = planBuild(baseInput({ config }));
        const mainCopies = mainOperations.filter(
            (op) => op.type === 'copyTree',
        ) as any[];
        expect(
            mainCopies.find((op) => op.from === '/proj/dev_mod'),
        ).toBeUndefined();
        // the normal mod is still built
        expect(
            mainCopies.find((op) => op.from === '/proj/my_mod'),
        ).toBeDefined();

        const devOperations = planBuild(
            baseInput({
                config: JSON.parse(JSON.stringify(config)),
                variant: 'development',
            }),
        );
        const devCopies = devOperations.filter(
            (op) => op.type === 'copyTree',
        ) as any[];
        expect(
            devCopies.find((op) => op.from === '/proj/dev_mod'),
        ).toBeDefined();
    });

    it('should generate mod.info at the mod root by default', () => {
        const operations = planBuild(baseInput());
        const writes = modInfoWrites(operations);

        expect(writes).toHaveLength(1);
        expect(writes[0].path).toBe(
            '/out/Test Project/Contents/mods/my_mod/mod.info',
        );
        expect(writes[0].content).toContain('id=my_mod');
        expect(writes[0].content).toContain('name=My Mod');
    });

    it('should skip mod.info generation when it already exists with auto-if-missing', () => {
        const input = baseInput();
        input.modSourceStates.my_mod.modInfoExists = { '': true };

        const operations = planBuild(input);

        expect(modInfoWrites(operations)).toHaveLength(0);
        expect(operations).toContainEqual({
            type: 'log',
            level: 'info',
            message: `- Skipping 'my_mod' mod.info generation (already exists, build.modInfo: "auto-if-missing")...`,
        });
    });

    it('should not generate mod.info with build.modInfo "skip"', () => {
        const config = baseInput().config;
        config.mods.my_mod.build = { modInfo: 'skip' };

        const operations = planBuild(baseInput({ config }));

        expect(modInfoWrites(operations)).toHaveLength(0);
        expect(operations).toContainEqual({
            type: 'log',
            level: 'info',
            message: `- Skipping 'my_mod' mod.info generation (build.modInfo: "skip")...`,
        });
    });

    it('should overwrite mod.info with build.modInfo "auto" even when it exists', () => {
        const config = baseInput().config;
        config.mods.my_mod.build = { modInfo: 'auto' };
        const input = baseInput({ config });
        input.modSourceStates.my_mod.modInfoExists = { '': true };

        const operations = planBuild(input);

        expect(modInfoWrites(operations)).toHaveLength(1);
    });

    it('should target Build 42 branch folders instead of the mod root', () => {
        const input = baseInput();
        input.modSourceStates.my_mod = {
            branchFolders: ['42_branch'],
            modInfoExists: { '': true, '42_branch': false },
        };

        const operations = planBuild(input);
        const writes = modInfoWrites(operations);

        expect(writes).toHaveLength(1);
        expect(writes[0].path).toBe(
            '/out/Test Project/Contents/mods/my_mod/42_branch/mod.info',
        );
    });

    it('should fall back to the mod root when branch folders are filtered out by excludes', () => {
        const config = baseInput().config;
        config.excludes = ['other_mod'];
        const input = baseInput({ config });
        input.modSourceStates.my_mod = {
            branchFolders: ['other_mod'],
            modInfoExists: { '': false, other_mod: false },
        };

        const operations = planBuild(input);
        const writes = modInfoWrites(operations);

        expect(writes).toHaveLength(1);
        expect(writes[0].path).toBe(
            '/out/Test Project/Contents/mods/my_mod/mod.info',
        );
    });

    it('should append _dev to mod ids and the output folder for the development variant', () => {
        const operations = planBuild(baseInput({ variant: 'development' }));

        const modCopy = operations.find(
            (op) =>
                op.type === 'copyTree' && (op as any).from === '/proj/my_mod',
        ) as any;
        expect(modCopy.to).toBe(
            '/out/Test Project - dev_branch/Contents/mods/my_mod_dev',
        );

        const writes = modInfoWrites(operations);
        expect(writes[0].content).toContain('id=my_mod_dev');
    });

    it('should rewrite the id of an existing mod.info in the development output', () => {
        const input = baseInput({ variant: 'development' });
        input.modSourceStates.my_mod.modInfoExists = { '': true };
        input.modSourceStates.my_mod.modInfoContent = {
            '': 'id=my_mod\nname=My Mod\nposter=poster.png\n',
        };

        const operations = planBuild(input);
        const writes = modInfoWrites(operations);

        expect(writes).toHaveLength(1);
        expect(writes[0].path).toBe(
            '/out/Test Project - dev_branch/Contents/mods/my_mod_dev/mod.info',
        );
        expect(writes[0].content).toBe(
            'id=my_mod_dev\nname=My Mod\nposter=poster.png\n',
        );
        expect(operations).toContainEqual({
            type: 'log',
            level: 'info',
            message: `- Patching 'my_mod' mod.info id to 'my_mod_dev' (development build)...`,
        });
    });

    it('should leave an existing mod.info untouched in the main variant', () => {
        const input = baseInput();
        input.modSourceStates.my_mod.modInfoExists = { '': true };
        input.modSourceStates.my_mod.modInfoContent = {
            '': 'id=my_mod\nname=My Mod\n',
        };

        const operations = planBuild(input);

        expect(modInfoWrites(operations)).toHaveLength(0);
        expect(operations).toContainEqual({
            type: 'log',
            level: 'info',
            message: `- Skipping 'my_mod' mod.info generation (already exists, build.modInfo: "auto-if-missing")...`,
        });
    });

    it('should fall back to a verbatim copy when no mod.info content is snapshotted', () => {
        const input = baseInput({ variant: 'development' });
        input.modSourceStates.my_mod.modInfoExists = { '': true };

        const operations = planBuild(input);

        expect(modInfoWrites(operations)).toHaveLength(0);
        expect(operations).toContainEqual({
            type: 'log',
            level: 'info',
            message: `- Skipping 'my_mod' mod.info generation (already exists, build.modInfo: "auto-if-missing")...`,
        });
    });

    it('should still align the mod.info id in development despite build.modInfo "skip"', () => {
        const config = baseInput().config;
        config.mods.my_mod.build = { modInfo: 'skip' };
        const input = baseInput({ config, variant: 'development' });
        input.modSourceStates.my_mod.modInfoExists = { '': true };
        input.modSourceStates.my_mod.modInfoContent = {
            '': 'id=my_mod\nname=My Mod\n',
        };

        const operations = planBuild(input);
        const writes = modInfoWrites(operations);

        expect(writes).toHaveLength(1);
        expect(writes[0].content).toBe('id=my_mod_dev\nname=My Mod\n');
    });

    it('should log the skip reason in development when nothing can be patched', () => {
        const config = baseInput().config;
        config.mods.my_mod.build = { modInfo: 'skip' };
        const input = baseInput({ config, variant: 'development' });
        input.modSourceStates.my_mod.modInfoExists = { '': true };

        const operations = planBuild(input);

        expect(modInfoWrites(operations)).toHaveLength(0);
        expect(operations).toContainEqual({
            type: 'log',
            level: 'info',
            message: `- Skipping 'my_mod' mod.info generation (build.modInfo: "skip")...`,
        });
    });

    it('should patch mod.info in Build 42 branch folder targets too', () => {
        const input = baseInput({ variant: 'development' });
        input.modSourceStates.my_mod = {
            branchFolders: ['42'],
            modInfoExists: { '': true, '42': true },
            modInfoContent: {
                '': 'id=my_mod\n',
                '42': 'id=my_mod\nname=My Mod\n',
            },
        };

        const operations = planBuild(input);
        const writes = modInfoWrites(operations);

        // Only branch folder targets get mod.info handling; the root file is
        // legacy Build 41 layout and is copied verbatim.
        expect(writes).toHaveLength(1);
        expect(writes[0].path).toBe(
            '/out/Test Project - dev_branch/Contents/mods/my_mod_dev/42/mod.info',
        );
        expect(writes[0].content).toBe('id=my_mod_dev\nname=My Mod\n');
    });

    it('should mark the dev build unlisted, exclude the workshop id and suffix the title', () => {
        const operations = planBuild(baseInput({ variant: 'development' }));
        const workshopWrite = operations.find(
            (op) => op.type === 'writeFile' && op.path.endsWith('workshop.txt'),
        ) as Extract<FileOperation, { type: 'writeFile' }>;

        expect(workshopWrite.path).toBe(
            '/out/Test Project - dev_branch/workshop.txt',
        );
        expect(workshopWrite.content).toContain(
            'title=Test Project - dev_branch',
        );
        expect(workshopWrite.content).toContain('visibility=unlisted');
        expect(workshopWrite.content).not.toContain('id=');
    });

    it('should forward description lines into workshop.txt', () => {
        const operations = planBuild(
            baseInput({ descriptionLines: ['line one', 'line two'] }),
        );
        const workshopWrite = operations.find(
            (op) => op.type === 'writeFile' && op.path.endsWith('workshop.txt'),
        ) as Extract<FileOperation, { type: 'writeFile' }>;

        expect(workshopWrite.content.split('\n')[0]).toBe('version=1');
        expect(workshopWrite.content).toContain('description=line one');
        expect(workshopWrite.content).toContain('description=line two');
    });

    it('should write workshop.txt last', () => {
        const operations = planBuild(baseInput());
        const last = operations[operations.length - 1] as any;

        expect(last.type).toBe('writeFile');
        expect(last.path).toBe('/out/Test Project/workshop.txt');
        expect(last.content).toContain('version=1');
        expect(last.content).toContain('id=12345');
    });

    it('should copy preview.png when it exists', () => {
        const operations = planBuild(baseInput());

        expect(operations).toContainEqual({
            type: 'log',
            level: 'info',
            message: `- Copying workshop 'preview.png'...`,
        });
        expect(operations).toContainEqual({
            type: 'copyFile',
            from: '/proj/workshop/preview.png',
            to: '/out/Test Project/preview.png',
        });
    });

    it('should warn when preview.png is missing', () => {
        const operations = planBuild(baseInput({ previewPngExists: false }));

        expect(operations).toContainEqual({
            type: 'log',
            level: 'warn',
            message: `- No workshop 'preview.png' found as '/proj/workshop/preview.png'...`,
        });
        expect(operations.filter((op) => op.type === 'copyFile')).toHaveLength(
            0,
        );
    });
});

describe('resolveBuildOutputPath (pure)', () => {
    it('should sanitize illegal Windows characters in the title', () => {
        const config = {
            ...baseConfig,
            workshop: { ...baseConfig.workshop, title: 'My: Project?' },
        } as IProjectConfig;

        expect(resolveBuildOutputPath(config, 'main')).toBe(
            '/out/My_ Project_',
        );
    });

    it('should suffix the dev output folder with " - dev_branch"', () => {
        expect(resolveBuildOutputPath(baseConfig, 'development')).toBe(
            '/out/Test Project - dev_branch',
        );
        expect(resolveBuildOutputPath(baseConfig, 'main')).toBe(
            '/out/Test Project',
        );
    });
});

describe('sanitizeFolderName (pure)', () => {
    it('should replace illegal Windows characters with underscores', () => {
        expect(sanitizeFolderName('a<b>:c"d')).toBe('a_b_c_d');
        expect(sanitizeFolderName('a?b*c|d')).toBe('a_b_c_d');
    });

    it('should return an underscore for an empty result', () => {
        expect(sanitizeFolderName('')).toBe('_');
        expect(sanitizeFolderName('::')).toBe('_');
    });
});

describe('collectIncludedModIds (pure)', () => {
    const config = {
        workshop: { title: 'T', visibility: 'public', tags: [] },
        mods: {
            normal_mod: { name: 'A', description: 'd' },
            dev_mod: { name: 'B', description: 'd', build: { devOnly: true } },
            gone_mod: { name: 'C', description: 'd' },
        },
        excludes: ['gone_mod'],
        outdir: '/out',
    } as unknown as IProjectConfig;

    it('main variant keeps included mods and drops dev-only and excluded ones', () => {
        expect(collectIncludedModIds(config, 'main')).toEqual(['normal_mod']);
    });

    it('development variant keeps dev-only mods but still drops excluded ones', () => {
        expect(collectIncludedModIds(config, 'development')).toEqual([
            'normal_mod',
            'dev_mod',
        ]);
    });
});
