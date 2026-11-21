import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { NODE_CAPABILITIES } from '../../packages/platform-node/src/index';
import { WEB_CAPABILITIES } from '../../packages/platform-web/src/web-capabilities';
import { MemoryFileSystem } from '../helpers/memory-file-system';
import {
    PROJECT_SCHEMA_VERSION,
    planBuild,
    validateProject,
    ValidationContext,
    loadProject,
} from '../../packages/core/src/index';

const CONFIG_URI = 'mem://project/project.json';

const VALID_CONFIG = {
    workshop: {
        id: 12345,
        title: 'Test Project',
        visibility: 'public',
        tags: ['Build 42'],
    },
    mods: { my_mod: { name: 'My Mod', description: 'A mod.' } },
    excludes: [],
    outdir: '/out',
};

describe('core is host-blind', () => {
    it('runs the load -> validate -> plan chain on an injected filesystem', async () => {
        const fs = new MemoryFileSystem();
        await fs.write(
            CONFIG_URI,
            new TextEncoder().encode(JSON.stringify(VALID_CONFIG)),
        );

        const project = await loadProject(fs, CONFIG_URI);
        expect(project.version).toBe(PROJECT_SCHEMA_VERSION);

        const context = new ValidationContext('project.json');
        validateProject(project.config, context);
        expect(context.hasErrors()).toBe(false);

        const operations = planBuild({
            config: project.config,
            variant: 'development',
            workshopTemplateDir: '/templates/workshop',
            projectDir: '/proj',
            modSourceStates: {
                my_mod: { branchFolders: [], modInfoExists: {} },
            },
            descriptionLines: [],
            previewPngExists: false,
        });

        const devOutput = operations.find(
            (op) => op.type === 'removeDir',
        ) as Extract<(typeof operations)[number], { type: 'removeDir' }>;
        expect(devOutput.path).toBe('/out/Test Project - dev_branch');

        const modInfoWrite = operations.find(
            (op) =>
                op.type === 'writeFile' &&
                op.path.endsWith('my_mod_dev/mod.info'),
        ) as Extract<(typeof operations)[number], { type: 'writeFile' }>;
        expect(modInfoWrite.content).toContain('id=my_mod_dev');
    });
});

describe('browser-safety gate', () => {
    const BROWSER_SAFE_ROOTS = [
        'packages/core/src',
        'packages/platform/src',
        'packages/platform-web/src',
    ];

    const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
        [
            /from\s+'(?:fs|fs\/promises|path|os|child_process|url|http|https|crypto|node:[^']*)'/,
            'node builtin import',
        ],
        [/\brequire\s*\(/, 'CommonJS require call'],
        [
            /\bprocess\.(?:cwd|argv|exit|env|stdout|stderr|execPath|pid)\b/,
            'process global access',
        ],
        [/__dirname|__filename/, 'CommonJS directory globals'],
    ];

    function collectSourceFiles(root: string): string[] {
        const files: string[] = [];
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            const full = join(root, entry.name);
            if (entry.isDirectory()) files.push(...collectSourceFiles(full));
            else if (entry.name.endsWith('.ts')) files.push(full);
        }
        return files;
    }

    it('finds no node imports or process globals in browser-safe packages', () => {
        const violations: string[] = [];

        for (const root of BROWSER_SAFE_ROOTS) {
            for (const file of collectSourceFiles(root)) {
                const content = readFileSync(file, 'utf8');
                for (const [pattern, label] of FORBIDDEN_PATTERNS) {
                    if (pattern.test(content)) {
                        violations.push(`${file}: ${label}`);
                    }
                }
            }
        }

        expect(violations).toEqual([]);
    });

    it('declares capability profiles that hide unsupported features', () => {
        expect(WEB_CAPABILITIES.node).toBe(false);
        expect(WEB_CAPABILITIES.shell).toBe(false);
        expect(WEB_CAPABILITIES.localExecutables).toBe(false);
        expect(WEB_CAPABILITIES.symlinks).toBe(false);
        expect(WEB_CAPABILITIES.workshopOutput).toBe(false);
        expect(WEB_CAPABILITIES.workspaceWrite).toBe(true);
        expect(WEB_CAPABILITIES.portableBuild).toBe(true);

        expect(NODE_CAPABILITIES.node).toBe(true);
        expect(NODE_CAPABILITIES.shell).toBe(true);
        expect(NODE_CAPABILITIES.workshopOutput).toBe(true);
        expect(NODE_CAPABILITIES.portableBuild).toBe(true);
    });
});
