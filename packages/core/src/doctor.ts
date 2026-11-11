/**
 * Unified project diagnostics — the single source both `pzstudio doctor`
 * and the VS Code explorer consume, so validation is never duplicated per
 * host.
 *
 * The engine is host-blind: it walks the project through the injected
 * ProjectFileSystem (URIs in, data out), asks PlatformCapabilities instead
 * of branching on the host, and reports findings as plain Diagnostic data.
 * Hosts stay responsible for gathering the host-specific inputs (resolved
 * output directory, template cache location, the running game build).
 */
import type {
    FileStat,
    PlatformCapabilities,
    ProjectFileSystem,
} from '@pzstudio/platform';
import type { IProjectConfig } from './project';
import {
    LoadedProject,
    ProjectLoadError,
    ProjectParseError,
    ProjectValidationError,
    ProjectVersionError,
    loadProject,
} from './project-contract';
import { collectIncludedModIds, joinPosix } from './buildplan';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * The area a diagnostic belongs to, in the order doctor prints them.
 * `environment` and `filesystem` are always checkable; the rest need a
 * successfully loaded project.json.
 */
export type DiagnosticModule =
    | 'project'
    | 'environment'
    | 'filesystem'
    | 'templates'
    | 'mods'
    | 'buildTarget'
    | 'workshop-link';

export interface Diagnostic {
    severity: DiagnosticSeverity;
    module: DiagnosticModule;
    /** Stable machine-readable id within the module, e.g. "mods.missing". */
    code: string;
    message: string;
    /** Actionable next step, shown when present. */
    hint?: string;
}

export interface DoctorInput {
    /** URI (or Node path) of the project root — the folder holding project.json. */
    projectDir: string;
    /** URI of the resolved build output directory, when the host knows it. */
    outDir?: string;
    /** URI of the project template's cache/source directory, when configured. */
    templateDir?: string;
    /** Display name of that template, used in messages. */
    templateName?: string;
    capabilities: PlatformCapabilities;
    /** The running game build (e.g. "42.2.0") to check pzBuildCompatibility against. */
    gameBuild?: string;
    /**
     * Dist-model workshop-link checks, computed by the HOST (they need
     * link-aware fs reads — lstat/readlink/realpath — that the browser-safe
     * contract does not carry). Core only renders. Node hosts compute via
     * the platform-node link manager; a browser host passes
     * `state: 'UNSUPPORTED_HOST'` entries or omits the field entirely.
     */
    workshopLinks?: WorkshopLinkCheckInput[];
    /**
     * The host's materialize decision (dist-always amendment §3). When
     * absent (browser hosts, or the config read failed) no deployment
     * diagnostic renders at all.
     */
    materialization?: {
        action: 'skip' | 'materialize';
        mode: 'symlink' | 'copy';
        /** The expanded deployment root; set iff action === 'materialize'. */
        outDir?: string;
        /** Symlink mode only: the target is a UNC/network volume. */
        targetNonLocal?: boolean;
    };
}

/** One host-computed workshop-link fact for the doctor to render. */
export interface WorkshopLinkCheckInput {
    /** Item (workshop slot) name the state belongs to. */
    item: string;
    /**
     * A platform-node copy-slot state (the link cascade's states plus the
     * copy materializer's COPY_SLOT / HAND_MADE_DIR), or
     * 'UNSUPPORTED_HOST' when the host cannot maintain junctions at all.
     */
    state: string;
    /** Detail text from the cascade (errno / raw target), when present. */
    detail?: string;
    /** Absolute path of the item's workshop VDF, when the host knows it. */
    vdfPath?: string;
}

export interface DoctorReport {
    projectDir: string;
    /** Present when project.json loaded successfully. */
    project?: LoadedProject;
    diagnostics: Diagnostic[];
}

/**
 * Compares a pzBuildCompatibility range ("42.x", "42.2", "*") against a
 * concrete game build ("42.20.1"). Numeric range components must equal the
 * build's component at the same position; "x"/"*" skip a position; extra
 * build components are allowed.
 * Returns undefined when the pair cannot be judged (unparseable tokens or
 * the build is missing a component the range pins down).
 */
export function matchBuildCompatibility(
    range: string,
    build: string,
): boolean | undefined {
    const rangeTokens = range.trim().split('.');
    const buildTokens = build.trim().split('.');
    if (rangeTokens.length === 0 || range.trim() === '') return undefined;

    for (let i = 0; i < rangeTokens.length; i++) {
        const token = rangeTokens[i].trim().toLowerCase();
        if (token === 'x' || token === '*') continue;
        if (!/^\d+$/.test(token)) return undefined;
        const buildToken = buildTokens[i]?.trim();
        if (buildToken === undefined || !/^\d+$/.test(buildToken)) {
            return undefined;
        }
        if (Number(token) !== Number(buildToken)) return false;
    }
    return true;
}

/** File names the workshop folder should carry, with their importance. */
const WORKSHOP_FILES: { name: string; severity: DiagnosticSeverity }[] = [
    { name: 'description.txt', severity: 'warning' },
    { name: 'preview.png', severity: 'info' },
];

function lastName(uri: string): string {
    const slash = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'));
    return slash === -1 ? uri : uri.substring(slash + 1);
}

/** Normalizes a URI/path for containment comparisons (separator, case, edges). */
function normalizedPath(uri: string): string {
    return uri.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

async function statOrNull(
    fs: ProjectFileSystem,
    uri: string,
): Promise<FileStat | undefined> {
    try {
        return await fs.stat(uri);
    } catch {
        return undefined;
    }
}

async function projectDiagnostics(
    fs: ProjectFileSystem,
    input: DoctorInput,
): Promise<{ diagnostics: Diagnostic[]; project?: LoadedProject }> {
    const diagnostics: Diagnostic[] = [];
    const projectJsonUri = joinPosix(input.projectDir, 'project.json');

    if (!(await statOrNull(fs, projectJsonUri))) {
        diagnostics.push({
            severity: 'error',
            module: 'project',
            code: 'project.missing',
            message: `No project.json found in '${input.projectDir}'.`,
            hint: 'Run this command inside a project directory, or create a project with pzstudio new.',
        });
        return { diagnostics };
    }

    try {
        const project = await loadProject(fs, projectJsonUri);
        if (project.migrations?.length) {
            diagnostics.push({
                severity: 'info',
                module: 'project',
                code: 'project.migrated',
                message: `${lastName(projectJsonUri)} uses a legacy layout, migrated in memory: ${project.migrations.join(', ')}.`,
                hint: 'Run pzstudio migrate to write the current schema version to disk.',
            });
        }
        return { diagnostics, project };
    } catch (err) {
        if (err instanceof ProjectVersionError) {
            diagnostics.push({
                severity: 'error',
                module: 'project',
                code: 'project.version',
                message: (err as Error).message,
                hint: 'Upgrade PZ Studio to work with this project.',
            });
        } else if (err instanceof ProjectValidationError) {
            diagnostics.push({
                severity: 'error',
                module: 'project',
                code: 'project.validation',
                message: (err as Error).message,
                hint: 'Fix the fields listed above in project.json.',
            });
        } else if (err instanceof ProjectParseError) {
            diagnostics.push({
                severity: 'error',
                module: 'project',
                code: 'project.parse',
                message: (err as Error).message,
                hint: 'Fix the JSON syntax of project.json and try again.',
            });
        } else if (err instanceof ProjectLoadError) {
            diagnostics.push({
                severity: 'error',
                module: 'project',
                code: 'project.load',
                message: (err as Error).message,
            });
        } else {
            diagnostics.push({
                severity: 'error',
                module: 'project',
                code: 'project.read',
                message: `Failed to inspect '${projectJsonUri}': ${(err as Error).message}`,
            });
        }
        return { diagnostics };
    }
}

async function loadedProjectDiagnostics(
    fs: ProjectFileSystem,
    input: DoctorInput,
): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];

    const workshopDir = joinPosix(input.projectDir, 'workshop');
    for (const file of WORKSHOP_FILES) {
        if (!(await statOrNull(fs, joinPosix(workshopDir, file.name)))) {
            diagnostics.push({
                severity: file.severity,
                module: 'project',
                code:
                    file.name === 'description.txt'
                        ? 'project.noDescription'
                        : 'project.noPreview',
                message: `workshop/${file.name} is missing.`,
                hint:
                    file.name === 'description.txt'
                        ? 'Add it so the Steam Workshop page ships with your description.'
                        : 'Add it so the Steam Workshop page shows a preview image.',
            });
        }
    }

    return diagnostics;
}

function environmentDiagnostics(
    capabilities: PlatformCapabilities,
): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (!capabilities.workshopOutput) {
        diagnostics.push({
            severity: 'info',
            module: 'environment',
            code: 'environment.noWorkshopOutput',
            message: 'This host cannot write into the game/workshop folders.',
            hint: 'Use the portable build export instead of direct workshop output here.',
        });
    }
    if (!capabilities.shell) {
        diagnostics.push({
            severity: 'info',
            module: 'environment',
            code: 'environment.noShell',
            message:
                'This host cannot spawn processes, so git-based template downloads are unavailable.',
            hint: 'Use fetch-based templates or templates bundled with the tool.',
        });
    }
    return diagnostics;
}

async function outputDirDiagnostics(
    fs: ProjectFileSystem,
    input: DoctorInput,
): Promise<Diagnostic[]> {
    if (!input.outDir) return [];
    const diagnostics: Diagnostic[] = [];
    const stat = await statOrNull(fs, input.outDir);
    if (!stat) {
        diagnostics.push({
            severity: 'info',
            module: 'filesystem',
            code: 'filesystem.outDirMissing',
            message: `The build output directory '${input.outDir}' does not exist yet.`,
            hint: 'It is created by the first build; nothing to fix.',
        });
        return diagnostics;
    }
    if (stat.type !== 'directory') {
        diagnostics.push({
            severity: 'error',
            module: 'filesystem',
            code: 'filesystem.outDirNotDirectory',
            message: `The configured build output '${input.outDir}' is not a directory.`,
            hint: 'Remove or rename the file at that path, or point outdir at a directory.',
        });
        return diagnostics;
    }
    const projectPath = normalizedPath(input.projectDir);
    const outPath = normalizedPath(input.outDir);
    if (projectPath !== '' && outPath.startsWith(`${projectPath}/`)) {
        diagnostics.push({
            severity: 'warning',
            module: 'filesystem',
            code: 'filesystem.outDirInsideProject',
            message: `The build output directory '${input.outDir}' sits inside the project folder.`,
            hint: 'Build output inside the project clutters the source tree and can be re-synced as if it were source. Point outdir outside the project.',
        });
    }
    return diagnostics;
}

async function templateDiagnostics(
    fs: ProjectFileSystem,
    input: DoctorInput,
): Promise<Diagnostic[]> {
    if (!input.templateDir) return [];
    const stat = await statOrNull(fs, input.templateDir);
    if (stat?.type === 'directory') return [];
    return [
        {
            severity: 'info',
            module: 'templates',
            code: 'templates.notCached',
            message: `The template cache for '${input.templateName ?? input.templateDir}' is not downloaded yet.`,
            hint: 'Run pzstudio update to pre-download it; scaffolding fetches on demand otherwise.',
        },
    ];
}

/**
 * A Build 42 branch is a direct subfolder of the mod folder that contains a
 * media/ directory — the same rule resolveModInfoTargets applies.
 * Throws when the mod folder itself cannot be listed.
 */
async function listBranchFolders(
    fs: ProjectFileSystem,
    modDirUri: string,
): Promise<string[]> {
    const entries = await fs.list(modDirUri);
    const branches: string[] = [];
    for (const entry of entries) {
        if (entry.type !== 'directory') continue;
        const media = await statOrNull(
            fs,
            joinPosix(modDirUri, entry.name, 'media'),
        );
        if (media?.type === 'directory') {
            branches.push(entry.name);
        }
    }
    return branches;
}

async function modsDiagnostics(
    fs: ProjectFileSystem,
    projectDir: string,
    config: IProjectConfig,
): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    const modIds = Object.keys(config.mods);
    const excludes = config.excludes ?? [];

    if (modIds.length === 0) {
        diagnostics.push({
            severity: 'warning',
            module: 'mods',
            code: 'mods.none',
            message: 'This project does not declare any mods yet.',
            hint: 'Add one with pzstudio add <modId>.',
        });
    }

    for (const id of excludes) {
        if (!config.mods[id]) {
            diagnostics.push({
                severity: 'warning',
                module: 'mods',
                code: 'mods.unknownExclude',
                message: `'${id}' is listed in excludes but no such mod exists in project.json.`,
                hint: 'Remove it from excludes or add the mod back.',
            });
        }
    }

    for (const modId of modIds) {
        const mod = config.mods[modId];
        const excluded = excludes.includes(modId);
        const devOnly = mod.build?.devOnly === true;
        if (excluded && devOnly) {
            diagnostics.push({
                severity: 'warning',
                module: 'mods',
                code: 'mods.devOnlyAndExcluded',
                message: `Mod '${modId}' is both excluded and marked dev-only, so it is never built.`,
                hint: 'Keep one of the two states (pzstudio modconfig).',
            });
        }

        const modDirUri = joinPosix(projectDir, modId);
        const stat = await statOrNull(fs, modDirUri);
        if (!stat) {
            diagnostics.push({
                severity: excluded ? 'warning' : 'error',
                module: 'mods',
                code: 'mods.missing',
                message: `Mod folder '${modId}' is declared in project.json but missing on disk.`,
                hint: excluded
                    ? 'Restore the folder or drop the stale entries (project.json mods + excludes).'
                    : 'Restore the folder or remove the entry with pzstudio delete.',
            });
            continue;
        }
        if (stat.type !== 'directory') {
            diagnostics.push({
                severity: 'error',
                module: 'mods',
                code: 'mods.notDirectory',
                message: `Mod path '${modId}' exists but is not a directory.`,
                hint: 'A mod must be a folder named after its id.',
            });
            continue;
        }

        let branches: string[];
        try {
            branches = await listBranchFolders(fs, modDirUri);
        } catch (err) {
            diagnostics.push({
                severity: 'warning',
                module: 'mods',
                code: 'mods.unreadable',
                message: `Mod folder '${modId}' could not be read: ${(err as Error).message}`,
                hint: 'Check the folder permissions.',
            });
            continue;
        }

        if (branches.length === 0) {
            diagnostics.push({
                severity: 'error',
                module: 'mods',
                code: 'mods.noBranch',
                message: `Mod '${modId}' has no Build 42 branch folder (a subfolder containing media/).`,
                hint: 'Create one, e.g. 42/media/..., so the mod has a place for mod.info and its content.',
            });
            continue;
        }

        if (mod.build?.modInfo === 'skip') {
            let anyInfo = false;
            for (const branch of branches) {
                const info = await statOrNull(
                    fs,
                    joinPosix(modDirUri, branch, 'mod.info'),
                );
                if (info?.type === 'file') {
                    anyInfo = true;
                    break;
                }
            }
            if (!anyInfo) {
                diagnostics.push({
                    severity: 'warning',
                    module: 'mods',
                    code: 'mods.noModInfo',
                    message: `Mod '${modId}' has no mod.info and build.modInfo is "skip", so the built mod will not load in game.`,
                    hint: 'Generate one (pzstudio modinfo) or remove the "skip" setting to let builds create it.',
                });
            }
        }
    }

    return diagnostics;
}

function buildTargetDiagnostics(
    config: IProjectConfig,
    gameBuild?: string,
): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const modIds = Object.keys(config.mods);

    if (
        modIds.length > 0 &&
        collectIncludedModIds(config, 'main').length === 0
    ) {
        diagnostics.push({
            severity: 'warning',
            module: 'buildTarget',
            code: 'buildTarget.noProduction',
            message:
                'No mod qualifies for the production output (all are dev-only or excluded).',
            hint: 'Production builds will be skipped and the existing output left untouched.',
        });
    }
    if (
        modIds.length > 0 &&
        collectIncludedModIds(config, 'development').length === 0
    ) {
        diagnostics.push({
            severity: 'warning',
            module: 'buildTarget',
            code: 'buildTarget.noDevelopment',
            message:
                'No mod qualifies for the development output (all are excluded).',
            hint: 'Development builds will be skipped and the existing output left untouched.',
        });
    }

    const range = config.pzBuildCompatibility;
    if (range && gameBuild) {
        const compatible = matchBuildCompatibility(range, gameBuild);
        if (compatible === false) {
            diagnostics.push({
                severity: 'warning',
                module: 'buildTarget',
                code: 'buildTarget.compatibility',
                message: `The project targets PZ build '${range}' but the running game is '${gameBuild}'.`,
                hint: 'Update pzBuildCompatibility in project.json if building against this game line is intentional. This is a warning and never blocks a build.',
            });
        }
    }

    if (config.build?.target === 'development') {
        diagnostics.push({
            severity: 'info',
            module: 'buildTarget',
            code: 'buildTarget.developmentOnly',
            message:
                'Default builds refresh the development output only (build.target = "development").',
            hint: 'Set build.target to "both" to keep the production output in sync too.',
        });
    }

    return diagnostics;
}

/**
 * Runs every check and returns the report. Diagnostics come grouped by
 * module in the fixed display order project → environment → filesystem →
 * templates → mods → buildTarget; checks that need a loaded project.json
 * are skipped when the file is missing or unreadable (its diagnostic is the
 * report then).
 */
export async function runDoctor(
    fs: ProjectFileSystem,
    input: DoctorInput,
): Promise<DoctorReport> {
    const { diagnostics: projectModule, project } = await projectDiagnostics(
        fs,
        input,
    );

    // Outside a project the report is just that one fact — environment and
    // filesystem notes would only bury the "you are in the wrong directory"
    // message the user needs.
    if (!project && projectModule.some((d) => d.code === 'project.missing')) {
        return { projectDir: input.projectDir, diagnostics: projectModule };
    }

    const diagnostics: Diagnostic[] = [...projectModule];
    if (project) {
        diagnostics.push(...(await loadedProjectDiagnostics(fs, input)));
    }
    diagnostics.push(...environmentDiagnostics(input.capabilities));
    diagnostics.push(...(await outputDirDiagnostics(fs, input)));
    diagnostics.push(...(await templateDiagnostics(fs, input)));
    if (project) {
        diagnostics.push(
            ...(await modsDiagnostics(fs, input.projectDir, project.config)),
        );
        diagnostics.push(
            ...buildTargetDiagnostics(project.config, input.gameBuild),
        );
    }
    diagnostics.push(...workshopLinkDiagnostics(input.workshopLinks ?? []));
    diagnostics.push(...materializationDiagnostics(input.materialization));
    if (input.materialization?.targetNonLocal) {
        diagnostics.push(
            workshopLinkDiagnostics([
                { item: '*', state: 'NON_LOCAL_TARGET' },
            ])[0],
        );
    }

    return project
        ? { projectDir: input.projectDir, project, diagnostics }
        : { projectDir: input.projectDir, diagnostics };
}

/**
 * Renders host-computed workshop-link facts into doctor diagnostics. Pure
 * mapping — every state gets a stable code, a severity, and an actionable
 * hint. NON_LOCAL_TARGET's wording is fail-closed: junctions cannot target
 * non-local volumes and pzstudio offers no copy fallback (owner decision,
 * 2026-11-11 — real-world failures are triaged via issues).
 */
export function workshopLinkDiagnostics(
    entries: WorkshopLinkCheckInput[],
): Diagnostic[] {
    const codes: Record<string, string> = {
        ATTACHED_OK: 'workshop-link.attached',
        MISSING_LINK: 'workshop-link.missing',
        COPY_SLOT: 'workshop-link.copy-slot',
        HAND_MADE_DIR: 'workshop-link.hand-made-dir',
        CONFLICT_REAL_DIR: 'workshop-link.conflict-real-dir',
        FOREIGN_LINK: 'workshop-link.foreign',
        DANGLING_LINK: 'workshop-link.dangling',
        UNOWNED_TARGET: 'workshop-link.unowned',
        NOT_DIRECTORY: 'workshop-link.not-directory',
        IDENTITY_MISMATCH: 'workshop-link.identity-mismatch',
        NON_LOCAL_TARGET: 'workshop-link.non-local',
        UNSUPPORTED_HOST: 'workshop-link.unsupported-host',
    };
    return entries.map((entryState): Diagnostic => {
        const state = entryState.state;
        const base = {
            module: 'workshop-link' as const,
            code:
                codes[state] ??
                `workshop-link.${state.toLowerCase().replace(/_/g, '-')}`,
            message: `Workshop link for '${entryState.item}': ${state}${
                entryState.detail ? ` (${entryState.detail})` : ''
            }.`,
        };
        const steamcmdHint = entryState.vdfPath
            ? `Upload with: steamcmd +login <user> +workshop_build_item "${entryState.vdfPath}" +quit`
            : undefined;
        switch (state) {
            case 'ATTACHED_OK':
                return {
                    ...base,
                    severity: 'info',
                    hint: steamcmdHint,
                };
            case 'COPY_SLOT':
                // A healthy engine-owned copy slot: reconciled on every
                // build; drift heals with the next one.
                return {
                    ...base,
                    severity: 'info',
                    hint: steamcmdHint,
                };
            case 'HAND_MADE_DIR':
                return {
                    ...base,
                    severity: 'warning',
                    hint: 'A real directory without a copy marker occupies the slot — hand-made content is never adopted. Move or rename it by hand, or run build with --backup-existing-workshop.',
                };
            case 'MISSING_LINK':
                return {
                    ...base,
                    severity: 'warning',
                    hint: 'Run pzstudio build to deploy the item.',
                };
            case 'CONFLICT_REAL_DIR':
                return {
                    ...base,
                    severity: 'warning',
                    hint: 'Run with --backup-existing-workshop to move the existing folder aside and attach the link.',
                };
            case 'FOREIGN_LINK':
                return {
                    ...base,
                    severity: 'warning',
                    hint: 'Pass --relink (or --force-link) to replace the foreign link after checking where it points.',
                };
            case 'DANGLING_LINK':
                return {
                    ...base,
                    severity: 'warning',
                    hint: 'Rebuild to recreate the dist directory and re-attach the link.',
                };
            case 'UNOWNED_TARGET':
                return {
                    ...base,
                    severity: 'warning',
                    hint: 'The dist directory carries no ownership marker for this project — rebuild to write it. If the slot belongs to another project, do not relink.',
                };
            case 'NON_LOCAL_TARGET':
                return {
                    ...base,
                    severity: 'warning',
                    hint: 'Point the deployment root at a local disk — junctions cannot target network volumes.',
                };
            case 'UNSUPPORTED_HOST':
                return {
                    ...base,
                    severity: 'info',
                };
            default:
                return { ...base, severity: 'warning' };
        }
    });
}

/**
 * Renders the materialize decision: an unset target is a legitimate pure
 * build state (CI/headless) — one INFO diagnostic, never a warning
 * (dist-always amendment §9). The MIGRATE_TO_DIST_MODEL diagnostic of the
 * 2026-11-11 design is gone: there is no legacy mode left to migrate.
 */
function materializationDiagnostics(
    materialization: DoctorInput['materialization'],
): Diagnostic[] {
    if (!materialization) return [];
    if (materialization.action === 'skip') {
        return [
            {
                module: 'workshop-link',
                code: 'OUTDIR_UNSET',
                severity: 'info',
                message:
                    'Deployment disabled — no outdir configured; the build wrote dist/ only.',
                hint: 'Set project.json "outdir" (pzstudio new writes "~/Zomboid/Workshop") or run pzstudio outdir to expose built items to the game.',
            },
        ];
    }
    return [];
}
