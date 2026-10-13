/**
 * Harness for the F23 copyTree destination-exclusion regression suite
 * (tests/unit/copytree-destination-exclusion.test.ts): the doc-14 §4
 * experiment axes — configurable listing order, complete write/delete
 * logs and strict operation budgets — around the real memory filesystem.
 */
import { MemoryFileSystem } from './memory-file-system';
import type { DirectoryEntry, ProjectFileSystem } from '@pzstudio/platform';
import type { BuildSessionHost } from '../../packages/core/src/buildsession';
import type { PlanBuildInput } from '../../packages/core/src/buildplan';
import type { IProjectConfig } from '../../packages/core/src/project';

export type ListOrder = 'alphabetical' | 'insertion' | 'reverse';

/**
 * Thrown by the harness when an engine flow exceeds its operation budget.
 * Reaching this error in a test is the deterministic RED signal for
 * unbounded traversal; passing flows must never observe it.
 */
export class BudgetExceededError extends Error {
    constructor(kind: 'write' | 'list', count: number, cap: number) {
        super(`${kind} budget exceeded: ${count} >= ${cap} (F23 guard)`);
        this.name = 'BudgetExceededError';
    }
}

/**
 * Memory filesystem with the three experiment axes from doc 14 §4: listing
 * order control (the F23 axis), a complete write/delete log and strict
 * operation budgets. Alphabetical emulates NTFS readdir; insertion is the
 * raw Map order (the documented adverse ordering); reverse is a second
 * adverse ordering.
 */
export class F23Fs extends MemoryFileSystem {
    order: ListOrder = 'alphabetical';
    writeCap = Infinity;
    listCap = Infinity;
    writes: string[] = [];
    deletes: string[] = [];
    /** URIs of every list() call since the last manual reset. */
    lists: string[] = [];
    private listCount = 0;

    async list(uri: string): Promise<DirectoryEntry[]> {
        this.listCount += 1;
        this.lists.push(uri);
        if (this.listCount > this.listCap) {
            throw new BudgetExceededError('list', this.listCount, this.listCap);
        }
        const entries = await this.rawList(uri);
        if (this.order === 'alphabetical') {
            return [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
        }
        if (this.order === 'reverse') {
            return [...entries].reverse();
        }
        return entries;
    }

    /**
     * The uninstrumented listing subclasses override to change resolution
     * semantics (case-insensitive lookup, symlink entries) while keeping
     * the budgets and the listing-order axis.
     */
    protected async rawList(uri: string): Promise<DirectoryEntry[]> {
        return super.list(uri); // MemoryFileSystem
    }

    async write(uri: string, data: Uint8Array): Promise<void> {
        if (this.writes.length >= this.writeCap) {
            throw new BudgetExceededError(
                'write',
                this.writes.length,
                this.writeCap,
            );
        }
        this.writes.push(uri);
        await super.write(uri, data);
    }

    async delete(uri: string): Promise<void> {
        this.deletes.push(uri);
        await super.delete(uri);
    }
}

export const TEMPLATE_DIR = '/templates/workshop';
export const PROJECT_DIR = '/proj';
export const MOD = 'my_mod';
export const MOD_ROOT = `${PROJECT_DIR}/${MOD}`;
export const TITLE = 'Sync Project';
export const MAIN_OUT_PREFIX = 'Sync Project';
export const DEV_OUT_PREFIX = 'Sync Project - dev_branch';

export function configFor(
    outdir: string,
    overrides?: {
        excludes?: string[];
        devOnlySecondMod?: boolean;
        title?: string;
    },
): IProjectConfig {
    const config = {
        workshop: {
            id: 12345,
            title: overrides?.title ?? TITLE,
            visibility: 'public',
            tags: [],
        },
        mods: {
            [MOD]: { name: 'My Mod', description: 'A mod.' },
        },
        excludes: overrides?.excludes ?? [],
        outdir,
    } as unknown as IProjectConfig;
    if (overrides?.devOnlySecondMod) {
        (config.mods as Record<string, unknown>).dev_mod = {
            name: 'Dev Mod',
            description: 'd.',
            build: { devOnly: true },
        };
    }
    return config;
}

/** Seeds the project fixture: mod source tree, template, project.json. */
export async function seedProject(
    fs: F23Fs,
    config: IProjectConfig,
    options?: { withSourceModInfo?: boolean },
): Promise<void> {
    await fs.writeText(`${PROJECT_DIR}/project.json`, JSON.stringify(config));
    await fs.writeText(`${TEMPLATE_DIR}/Contents/template-file.txt`, 'tpl');
    if (options?.withSourceModInfo) {
        await fs.writeText(`${MOD_ROOT}/mod.info`, 'id=my_mod\nname=My Mod\n');
    }
    await fs.writeText(`${MOD_ROOT}/media/lua/hello.lua`, 'print("v1")');
    await fs.writeText(`${MOD_ROOT}/media/lua/util.lua`, 'print("util")');
    await fs.writeText(`${MOD_ROOT}/media/other.lua`, 'other');
    await fs.writeText(`${MOD_ROOT}/media/old.lua`, 'old');
    await fs.writeText(`${MOD_ROOT}/scratch/x.lua`, 'scratch');
    await fs.writeText(
        `${MOD_ROOT}/.pzstudioignore`,
        'scratch/\nmedia/old.lua\n',
    );
    await fs.writeText(`${MOD_ROOT}/.gitkeep`, '');
    await fs.writeText(`${MOD_ROOT}/.dotfile`, 'x');
    await fs.writeText(`${MOD_ROOT}/staging/keep.lua`, 'keep');
}

/**
 * Session host mirroring the CLI's gatherPlanInput facts (config, template,
 * per-mod source snapshots, workshop metadata) through the injected fs.
 * The config lives in a mutable holder so a structural delta (project.json)
 * makes the next rebuild adopt the new outdir.
 */
export function createHost(
    fs: ProjectFileSystem & {
        readText(uri: string): Promise<string>;
        writeText(uri: string, content: string): Promise<void>;
    },
    holder: { config: IProjectConfig },
): {
    host: BuildSessionHost;
    logs: string[];
} {
    const logs: string[] = [];
    const host: BuildSessionHost = {
        fs,
        getPlanInput: async (): Promise<Omit<PlanBuildInput, 'variant'>> => {
            const config = holder.config;
            const modSourceStates: PlanBuildInput['modSourceStates'] = {};
            for (const modId of Object.keys(config.mods)) {
                const state = {
                    branchFolders: [] as string[],
                    modInfoExists: {} as Record<string, boolean>,
                    modInfoContent: {} as Record<string, string | undefined>,
                };
                state.modInfoExists[''] = false;
                state.modInfoContent[''] = undefined;
                try {
                    state.modInfoContent[''] = await fs.readText(
                        `${PROJECT_DIR}/${modId}/mod.info`,
                    );
                    state.modInfoExists[''] = true;
                } catch {
                    // no root mod.info
                }
                const entries = await fs.list(`${PROJECT_DIR}/${modId}`);
                for (const entry of entries) {
                    if (entry.type !== 'directory') continue;
                    try {
                        await fs.stat(`${entry.uri}/media`);
                        state.branchFolders.push(entry.name);
                        state.modInfoExists[entry.name] = false;
                        state.modInfoContent[entry.name] = undefined;
                    } catch {
                        // not a Build 42 branch folder
                    }
                }
                modSourceStates[modId] = state;
            }
            let descriptionLines: string[] = [];
            try {
                descriptionLines = (
                    await fs.readText(`${PROJECT_DIR}/workshop/description.txt`)
                ).split(/\r?\n/);
            } catch {
                // no description file
            }
            let previewPngExists = false;
            try {
                await fs.stat(`${PROJECT_DIR}/workshop/preview.png`);
                previewPngExists = true;
            } catch {
                // no preview
            }
            return {
                config,
                workshopTemplateDir: TEMPLATE_DIR,
                projectDir: PROJECT_DIR,
                modSourceStates,
                descriptionLines,
                previewPngExists,
            };
        },
        log: (level, message) => logs.push(`${level}:${message}`),
    };
    return { host, logs };
}

/** URIs of every stored file under the given prefix (sorted for diffing). */
export function keysUnder(
    fs: { files: Map<string, Uint8Array> },
    prefix: string,
): string[] {
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return [...fs.files.keys()]
        .filter((key) => key.startsWith(normalized))
        .sort();
}

/** Maximum number of `/Contents/mods/` repetitions in any single key. */
export function maxNesting(keys: string[]): number {
    let max = 0;
    for (const key of keys) {
        const count = key.split('/Contents/mods/').length - 1;
        if (count > max) max = count;
    }
    return max;
}

export function variantRoot(
    root: string,
    variant: 'main' | 'development',
): string {
    return `${root}/${variant === 'main' ? MAIN_OUT_PREFIX : DEV_OUT_PREFIX}`;
}
