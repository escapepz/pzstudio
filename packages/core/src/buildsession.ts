/**
 * BuildSession — the Development Sync Engine.
 *
 * ONE engine drives `pzstudio build`, `pzstudio watch` and the VS Code
 * auto-sync: hosts watch their own filesystems (chokidar, FileSystemWatcher)
 * and feed file deltas into apply(); the session classifies them and keeps
 * the workshop outputs in sync with the smallest correct amount of work:
 *
 * - plain file deltas (CREATE/CHANGE/DELETE) are applied incrementally;
 * - anything with planner-level semantics (mod.info generation, ignore-rule
 *   files) falls back to a scoped rebuild of the affected mod;
 * - structural changes (project.json) trigger a full rebuild through the
 *   pure planner, exactly like `pzstudio build`.
 *
 * The session is host-agnostic: it plans and executes through the injected
 * ProjectFileSystem and asks the host for fresh plan inputs (config,
 * template dir, source snapshots) whenever it needs to re-read the world.
 */
import type { ProjectFileSystem } from '@pzstudio/platform';
import {
    collectIncludedModIds,
    FileOperation,
    joinPosix,
    modIdForVariant,
    PlanBuildInput,
    planModOperations,
    planBuild,
    resolveBuildOutputPath,
    workshopTextForVariant,
} from './buildplan';
import {
    decodeUtf8,
    encodeUtf8,
    executeFileOperations,
    isSourcePathIncluded,
    OperationLogLevel,
} from './execute';

export type BuildVariant = 'main' | 'development';

/**
 * One filesystem event, already resolved to an absolute path in the host's
 * path space. RENAME events are expressed by hosts as a delete of the old
 * path plus a create of the new one.
 */
export interface FileDelta {
    type: 'create' | 'change' | 'delete';
    path: string;
}

/** Normalizes a path for comparison (never for filesystem access). */
function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Collapses a burst of events so every path appears once with its final
 * state: create→change stays a create, any→delete stays a delete,
 * delete→create becomes a create. First-occurrence order is preserved.
 */
export function coalesceDeltas(deltas: FileDelta[]): FileDelta[] {
    const byPath = new Map<string, FileDelta>();
    const order: string[] = [];
    for (const delta of deltas) {
        const key = normalizePath(delta.path);
        const previous = byPath.get(key);
        if (!previous) {
            byPath.set(key, { ...delta });
            order.push(key);
            continue;
        }
        let type: FileDelta['type'];
        if (previous.type === 'delete' && delta.type === 'create') {
            type = 'create';
        } else if (delta.type === 'delete') {
            type = 'delete';
        } else if (previous.type === 'create') {
            type = 'create';
        } else {
            type = 'change';
        }
        byPath.set(key, { type, path: delta.path });
    }
    return order.map((key) => byPath.get(key)!);
}

/**
 * The variants a mod is currently included in, per the plan input's config.
 * Dev-only mods only qualify for development; excluded mods for neither.
 */
function includedVariantsFor(
    config: PlanBuildInput['config'],
    modId: string,
): BuildVariant[] {
    return (['main', 'development'] as BuildVariant[]).filter((variant) =>
        collectIncludedModIds(config, variant).includes(modId),
    );
}

/**
 * What classifyDelta decided for one event. `mod-file` deltas carry the
 * variants the mod is currently included in; the session intersects that
 * with the variants the session was started for.
 */
export type DeltaClassification =
    | { kind: 'ignore'; reason: string }
    | { kind: 'full-rebuild'; reason: string }
    | { kind: 'workshop-text' }
    | { kind: 'workshop-preview' }
    | {
          kind: 'mod-file';
          modId: string;
          /** Path of the file inside the mod folder, '/'-separated. */
          relativePath: string;
          variants: BuildVariant[];
          type: FileDelta['type'];
      }
    | {
          kind: 'mod-scoped';
          modId: string;
          reason: string;
          variants: BuildVariant[];
      };

/**
 * Classifies one delta against a plan input. Pure: the session and the CLI
 * can both use it, and tests can drive it without any filesystem.
 */
export function classifyDelta(
    delta: FileDelta,
    planInput: Omit<PlanBuildInput, 'variant'>,
): DeltaClassification {
    const config = planInput.config;
    const projectDir = normalizePath(planInput.projectDir);
    const path = normalizePath(delta.path);

    if (!path.startsWith(`${projectDir}/`)) {
        return { kind: 'ignore', reason: 'outside the project directory' };
    }
    const rel = path.slice(projectDir.length + 1);
    if (rel === '') {
        return { kind: 'ignore', reason: 'project directory itself' };
    }

    if (rel === 'project.json') {
        return {
            kind: 'full-rebuild',
            reason: 'project.json changed (structural)',
        };
    }

    const segments = rel.split('/');
    if (segments[0].startsWith('.')) {
        return { kind: 'ignore', reason: 'dot entry at project root' };
    }

    if (rel === 'workshop/description.txt') {
        return { kind: 'workshop-text' };
    }
    if (rel === 'workshop/preview.png') {
        return { kind: 'workshop-preview' };
    }
    if (segments[0] === 'workshop') {
        return { kind: 'ignore', reason: 'unused workshop file' };
    }

    const modId = segments[0];
    if (!config.mods[modId]) {
        return { kind: 'ignore', reason: `'${modId}' is not a configured mod` };
    }
    if ((config.excludes ?? []).includes(modId)) {
        return { kind: 'ignore', reason: `mod '${modId}' is excluded` };
    }

    const rest = segments.slice(1);
    if (rest.length === 0) {
        return { kind: 'ignore', reason: 'folder-level event on the mod root' };
    }

    // build.modInfo semantics (generation flags, dev id alignment) are
    // planner territory: any mod.info event rebuilds the mod instead of
    // guessing what the planner would have written.
    const name = rest[rest.length - 1];
    if (name === 'mod.info') {
        return {
            kind: 'mod-scoped',
            modId,
            reason: 'mod.info changed (generation/patching semantics)',
            variants: includedVariantsFor(config, modId),
        };
    }
    // A .pzstudioignore changes the rules for everything below it.
    if (name === '.pzstudioignore') {
        return {
            kind: 'mod-scoped',
            modId,
            reason: '.pzstudioignore changed (ignore rules)',
            variants: includedVariantsFor(config, modId),
        };
    }

    // Everything inside a dot entry is invisible to the build.
    if (rest.some((segment) => segment.startsWith('.'))) {
        return { kind: 'ignore', reason: 'dot entry inside the mod' };
    }

    const child = rest[0];
    if ((config.excludes ?? []).includes(child)) {
        return { kind: 'ignore', reason: `'${child}' is in excludes` };
    }

    const variants = includedVariantsFor(config, modId);
    if (variants.length === 0) {
        return { kind: 'ignore', reason: `mod '${modId}' is not built` };
    }
    return {
        kind: 'mod-file',
        modId,
        relativePath: rest.join('/'),
        variants,
        type: delta.type,
    };
}

/**
 * Plans the re-sync of ONE mod inside ONE variant's existing output: drop
 * the mod's output folder, then run the same per-mod plan a full build
 * would. workshop.txt is untouched (the mod set did not change).
 */
export function planScopedModRebuild(
    input: Omit<PlanBuildInput, 'variant'>,
    variant: BuildVariant,
    modId: string,
): FileOperation[] {
    const outPath = resolveBuildOutputPath(input.config, variant);
    const outModsPath = joinPosix(
        outPath,
        'Contents',
        'mods',
        modIdForVariant(modId, variant),
    );

    const operations: FileOperation[] = [];
    operations.push({
        type: 'log',
        level: 'info',
        message: `- Re-syncing mod '${modId}' (${variant})...`,
    });
    // The output root may have been removed externally; per-mod copyTree
    // writes recreate missing parents, but the folder itself must exist for
    // the case where the mod tree is empty after filtering.
    operations.push({ type: 'makeDir', path: outPath });
    operations.push({ type: 'removeDir', path: outModsPath });
    operations.push(
        ...planModOperations({ ...input, variant }, variant, modId),
    );
    return operations;
}

/** What apply() did with a batch of deltas. */
export interface SessionApplyResult {
    /** Number of files written or deleted incrementally. */
    incremental: number;
    /** Mods that went through a scoped rebuild, with their variants. */
    scoped: Array<{ modId: string; variants: BuildVariant[] }>;
    /** True when a structural change forced a full rebuild. */
    fullRebuild: boolean;
    /** Deltas that needed no action (dot entries, unknown folders, ...). */
    ignored: number;
    /** Error messages per failed action — apply() never throws. */
    errors: string[];
}

/**
 * One-line summary of an apply() result for hosts that surface sync
 * activity (CLI watch, the extension output channel). A successful sync
 * is otherwise silent — this line makes "nothing happened" unambiguous.
 * Returns '' when the batch did nothing worth announcing (only ignored
 * deltas and no errors).
 */
export function summarizeApplyResult(result: SessionApplyResult): string {
    const summary: string[] = [];
    if (result.incremental > 0) {
        summary.push(`${result.incremental} file(s) synced`);
    }
    if (result.scoped.length > 0) {
        summary.push(
            `re-synced mod(s): ${result.scoped.map((s) => s.modId).join(', ')}`,
        );
    }
    if (result.fullRebuild) {
        summary.push('full rebuild');
    }
    return summary.join('; ');
}

/**
 * The host side of a session: filesystem access plus fresh plan inputs.
 * getPlanInput() must re-read the config, resolve the workshop template,
 * snapshot every mod's source state and read the workshop metadata — it is
 * the same work `pzstudio build` does before planning.
 */
export interface BuildSessionHost {
    fs: ProjectFileSystem;
    getPlanInput(): Promise<Omit<PlanBuildInput, 'variant'>>;
    log?(level: OperationLogLevel, message: string): void;
}

function isLockError(e: unknown): boolean {
    const code = (e as { code?: string } | undefined)?.code;
    return (
        code === 'ENOTEMPTY' ||
        code === 'EBUSY' ||
        code === 'EPERM' ||
        code === 'EACCES'
    );
}

/**
 * Node adapters surface a vanished file as ENOENT (by code or message);
 * the in-memory test fs only has the message. A vanished source is not a
 * sync failure — see applyModFileIncremental.
 */
function isMissingSource(e: unknown): boolean {
    const err = e as { code?: string; message?: string } | undefined;
    return err?.code === 'ENOENT' || (err?.message ?? '').includes('ENOENT');
}

function describeError(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    if (isLockError(e)) {
        return `${message} (the folder is in use by another program — the change will be re-applied on the next save or full rebuild)`;
    }
    return message;
}

export class BuildSession {
    private readonly host: BuildSessionHost;
    private planInput: Omit<PlanBuildInput, 'variant'> | undefined;
    private variants: BuildVariant[] = [];
    private stopped = false;
    /** Serializes apply()/rebuild() so overlapping saves cannot interleave. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(host: BuildSessionHost) {
        this.host = host;
    }

    private log(level: OperationLogLevel, message: string): void {
        this.host.log?.(level, message);
    }

    /**
     * Runs the initial full build for the given variants and remembers the
     * plan input as the sync baseline. Throws when a variant fails — the
     * host decides whether to abort startup.
     */
    async start(
        variants: BuildVariant[] = ['main', 'development'],
    ): Promise<void> {
        if (this.stopped) {
            throw new Error('The build session has been stopped.');
        }
        this.variants = [...variants];
        this.planInput = await this.host.getPlanInput();
        await this.buildVariants(this.variants);
        this.log(
            'info',
            `Watching for changes... (${this.variants.join(', ')})`,
        );
    }

    /**
     * Forces a full rebuild with a fresh plan input (fresh config, fresh
     * snapshots), then re-baselines the session.
     */
    async rebuild(): Promise<void> {
        return this.enqueue(async () => {
            this.planInput = await this.host.getPlanInput();
            await this.buildVariants(this.variants);
        });
    }

    /**
     * Applies a batch of deltas. Never throws: per-action failures are
     * collected in the result so a transient lock does not kill a watch.
     */
    apply(deltas: FileDelta[]): Promise<SessionApplyResult> {
        return this.enqueue(() => this.applyCoalesced(coalesceDeltas(deltas)));
    }

    /** Stops accepting work; pending queued work drains first. */
    async stop(): Promise<void> {
        this.stopped = true;
        await this.queue;
    }

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const run = this.queue.then(work, work);
        // Keep the chain alive regardless of failures.
        this.queue = run.then(
            (): void => undefined,
            (): void => undefined,
        );
        return run;
    }

    private async buildVariants(variants: BuildVariant[]): Promise<void> {
        const planInput = this.planInput!;
        const errors: string[] = [];
        for (const variant of variants) {
            const included = collectIncludedModIds(planInput.config, variant);
            if (included.length === 0) {
                this.log(
                    'warn',
                    `All mods are excluded or dev-only — nothing to build for the ${
                        variant === 'main' ? 'main' : 'dev_branch'
                    } output.`,
                );
                continue;
            }
            try {
                await executeFileOperations(
                    this.host.fs,
                    planBuild({ ...planInput, variant }),
                    (level, message) => this.log(level, message),
                );
            } catch (e) {
                errors.push(
                    `${variant === 'main' ? 'main' : 'dev_branch'}: ${describeError(e)}`,
                );
            }
        }
        if (errors.length > 0) {
            throw new Error(errors.join('\n'));
        }
    }

    private async applyCoalesced(
        deltas: FileDelta[],
    ): Promise<SessionApplyResult> {
        const result: SessionApplyResult = {
            incremental: 0,
            scoped: [],
            fullRebuild: false,
            ignored: 0,
            errors: [],
        };
        if (this.stopped || !this.planInput) {
            return result;
        }

        const scopedByMod = new Map<string, Set<BuildVariant>>();
        const modFiles: Extract<DeltaClassification, { kind: 'mod-file' }>[] =
            [];
        let workshopTextNeeded = false;
        const previews: FileDelta[] = [];

        for (const delta of deltas) {
            const classification = classifyDelta(delta, this.planInput);
            switch (classification.kind) {
                case 'ignore':
                    result.ignored += 1;
                    this.log(
                        'verbose',
                        `Skipped ${delta.type} '${delta.path}': ${classification.reason}.`,
                    );
                    break;
                case 'full-rebuild':
                    this.log('info', `- ${classification.reason}.`);
                    await this.doFullRebuild(result);
                    return result;
                case 'workshop-text':
                    workshopTextNeeded = true;
                    break;
                case 'workshop-preview':
                    if (delta.type !== 'delete') {
                        previews.push(delta);
                    }
                    break;
                case 'mod-scoped':
                    this.log(
                        'info',
                        `- ${classification.reason} — re-syncing mod '${classification.modId}'.`,
                    );
                    scopedByMod.set(
                        classification.modId,
                        new Set(classification.variants),
                    );
                    break;
                case 'mod-file':
                    modFiles.push(classification);
                    break;
            }
        }

        // Incremental file application first: cheap, covers the common
        // save-a-Lua-file case without touching anything else.
        for (const file of modFiles) {
            const variants = file.variants.filter((variant) =>
                this.variants.includes(variant),
            );
            if (variants.length === 0) {
                continue;
            }
            await this.applyModFileIncremental(file, variants, result);
        }

        if (workshopTextNeeded) {
            await this.rewriteWorkshopText(result);
        }
        for (const preview of previews) {
            await this.copyPreview(preview, result);
        }

        // Scoped rebuilds last, with fresh source snapshots: the delta that
        // triggered them is part of the tree they re-read.
        if (scopedByMod.size > 0) {
            const freshInput = await this.host.getPlanInput();
            this.planInput = freshInput;
            for (const [modId, variantSet] of scopedByMod) {
                const variants = [...variantSet].filter((variant) =>
                    this.variants.includes(variant),
                );
                for (const variant of variants) {
                    try {
                        await executeFileOperations(
                            this.host.fs,
                            planScopedModRebuild(freshInput, variant, modId),
                            (level, message) => this.log(level, message),
                        );
                    } catch (e) {
                        result.errors.push(describeError(e));
                    }
                }
                result.scoped.push({ modId, variants });
            }
        }

        return result;
    }

    private async doFullRebuild(result: SessionApplyResult): Promise<void> {
        try {
            this.planInput = await this.host.getPlanInput();
            await this.buildVariants(this.variants);
            result.fullRebuild = true;
        } catch (e) {
            result.errors.push(describeError(e));
        }
    }

    private async applyModFileIncremental(
        file: Extract<DeltaClassification, { kind: 'mod-file' }>,
        variants: BuildVariant[],
        result: SessionApplyResult,
    ): Promise<void> {
        const planInput = this.planInput!;
        const sourceRoot = joinPosix(planInput.projectDir, file.modId);
        const modSource = joinPosix(
            sourceRoot,
            ...file.relativePath.split('/'),
        );

        try {
            // Watchers report directories as create/change events too (the
            // extension's FileSystemWatcher and @parcel/watcher alike). The
            // engine only ever syncs files — a directory event is skipped,
            // while delete events may target directories and remove them
            // from the output recursively below.
            if (file.type !== 'delete') {
                try {
                    const stat = await this.host.fs.stat(modSource);
                    if (stat.type === 'directory') {
                        result.ignored += 1;
                        this.log(
                            'verbose',
                            `Skipped '${modSource}': directory event.`,
                        );
                        return;
                    }
                } catch {
                    // The source may have vanished entirely; the read below
                    // handles that case.
                }
            }

            // Read once for every variant. Watchers deliver events for
            // transient files too (atomic saves, temp copies) — when the
            // source is already gone by the time the batch runs there is
            // nothing to sync: real removals arrive as delete events.
            let content: Uint8Array | undefined;
            if (file.type !== 'delete') {
                try {
                    content = await this.host.fs.read(modSource);
                } catch (e) {
                    if (isMissingSource(e)) {
                        result.ignored += 1;
                        this.log(
                            'verbose',
                            `Skipped ${file.type} '${modSource}': the source vanished before the sync.`,
                        );
                        return;
                    }
                    result.errors.push(describeError(e));
                    return;
                }
            }

            // Same filter the full build used for this mod's copyTree; the
            // project excludes for direct children were already handled by
            // classifyDelta. Rules do not vary per variant, so evaluate once.
            const included = await isSourcePathIncluded(
                this.host.fs,
                sourceRoot,
                file.relativePath,
                { excludeIgnoreFile: true, ignoreDotFiles: true },
            );
            if (!included) {
                result.ignored += 1;
                this.log(
                    'verbose',
                    `Skipped '${modSource}': excluded by ignore rules.`,
                );
                return;
            }

            const errors = new Set<string>();
            for (const variant of variants) {
                const outPath = resolveBuildOutputPath(
                    planInput.config,
                    variant,
                );
                const modDestination = joinPosix(
                    outPath,
                    'Contents',
                    'mods',
                    modIdForVariant(file.modId, variant),
                    ...file.relativePath.split('/'),
                );
                try {
                    if (file.type === 'delete') {
                        await this.host.fs.delete(modDestination, {
                            recursive: true,
                        });
                    } else {
                        await this.host.fs.write(modDestination, content!);
                    }
                    result.incremental += 1;
                } catch (e) {
                    errors.add(describeError(e));
                }
            }
            // Both variants fail on the same source read most of the time —
            // report the distinct causes once each.
            result.errors.push(...errors);
        } catch (e) {
            result.errors.push(describeError(e));
        }
    }

    private async rewriteWorkshopText(
        result: SessionApplyResult,
    ): Promise<void> {
        const planInput = this.planInput!;
        let descriptionLines: string[] = [];
        try {
            const raw = await this.host.fs.read(
                joinPosix(planInput.projectDir, 'workshop', 'description.txt'),
            );
            descriptionLines = decodeUtf8(raw).split(/\r?\n/);
        } catch {
            // Missing description file: a full build generates without one.
        }
        for (const variant of this.variants) {
            try {
                await this.host.fs.write(
                    joinPosix(
                        resolveBuildOutputPath(planInput.config, variant),
                        'workshop.txt',
                    ),
                    encodeUtf8(
                        workshopTextForVariant(
                            planInput.config,
                            variant,
                            descriptionLines,
                        ),
                    ),
                );
                result.incremental += 1;
            } catch (e) {
                result.errors.push(describeError(e));
            }
        }
    }

    private async copyPreview(
        delta: FileDelta,
        result: SessionApplyResult,
    ): Promise<void> {
        const planInput = this.planInput!;
        for (const variant of this.variants) {
            try {
                await this.host.fs.write(
                    joinPosix(
                        resolveBuildOutputPath(planInput.config, variant),
                        'preview.png',
                    ),
                    await this.host.fs.read(delta.path),
                );
                result.incremental += 1;
            } catch (e) {
                result.errors.push(describeError(e));
            }
        }
    }
}
