import { basename, join, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
    NodeFileSystem,
    NODE_CAPABILITIES,
    inspectMaterializeSlot,
} from '@pzstudio/platform-node';
import {
    runDoctor,
    DoctorReport,
    resolveBuildOutputPath,
    computeProjectId,
    copyMarkerPath,
    readCopySlotMarker,
    type IProjectConfig,
    type WorkshopLinkCheckInput,
} from '@pzstudio/core';
import {
    getExternalProjectDir,
    getOutDir,
    legacySettings,
    readProjectConfig,
    setProjectDir,
} from './helper';
import { probeTemplateCacheDir, getConfigPath } from './templateManager';
import { legacyLogger, engineIo } from './logger';
import type { PzStudioHostSettings, PzStudioLogger } from './invocation';
import {
    nodeLinkFs,
    promisesFileSystem,
    resolveMaterialization,
    workshopReadMarker,
    type MaterializationResolution,
} from './linkStep';

export interface ProjectDoctorOptions {
    gameBuild?: string;
}

export interface ProjectDoctorCoreDeps {
    settings?: PzStudioHostSettings | (() => PzStudioHostSettings | undefined);
    logger: PzStudioLogger;
    gameBuild?: string;
}

function resolveDep<T>(dep: T | (() => T)): T {
    return typeof dep === 'function' ? (dep as () => T)() : dep;
}

export async function runProjectDoctorCore(
    projectPath: string,
    deps: ProjectDoctorCoreDeps,
): Promise<DoctorReport> {
    const settings = resolveDep(deps.settings);
    const io = { logger: deps.logger };

    let outDir: string | undefined;
    let workshop:
        | Awaited<ReturnType<typeof resolveDoctorWorkshopInputs>>
        | undefined;
    try {
        const config = readProjectConfig(
            join(projectPath, 'project.json'),
            true,
            io,
        );
        if (config) {
            outDir = getOutDir(config, undefined, {
                projectDir: projectPath,
                settings,
                logger: deps.logger,
            });
            workshop = await resolveDoctorWorkshopInputs(
                projectPath,
                config,
                outDir,
            );
        }
    } catch {}

    let template: { dir: string; name: string } | undefined;
    try {
        template = probeTemplateCacheDir('project', {
            settings,
            logger: deps.logger,
        });
    } catch {}

    return await runDoctor(new NodeFileSystem(), {
        projectDir: projectPath,
        outDir,
        templateDir: template?.dir,
        templateName: template?.name,
        capabilities: NODE_CAPABILITIES,
        gameBuild: deps.gameBuild,
        workshopLinks: workshop?.workshopLinks,
        materialization: workshop?.materialization,
    });
}

export async function resolveDoctorWorkshopInputs(
    projectPath: string,
    config: IProjectConfig,
    effectiveOutdir?: string,
): Promise<{
    materialization: MaterializationResolution;
    workshopLinks?: WorkshopLinkCheckInput[];
}> {
    const root = resolve(projectPath);
    const materialization = resolveMaterialization({
        projectRoot: root,
        effectiveOutdir,
        projectMaterialize: config.build?.materialize,
        globalMaterialize: readMaterializeFromGlobalConfig(),
    });
    if (materialization.action !== 'materialize') {
        return { materialization };
    }

    const platform =
        process.platform === 'win32' ? ('win32' as const) : ('posix' as const);
    const readMarker = workshopReadMarker(root);
    const projectId = await computeProjectId(root);
    const distRoot = materialization.distRoot;
    const targetNonLocal =
        materialization.mode === 'symlink' &&
        (materialization.outDir!.startsWith('\\\\') ||
            materialization.outDir!.startsWith('//'));

    const items = (['main', 'development'] as const)
        .map((variant) =>
            resolveBuildOutputPath({ ...config, outdir: distRoot }, variant),
        )
        .filter((dir) => existsSync(dir))
        .map((dir) => ({ name: basename(dir) }));
    const workshopLinks: WorkshopLinkCheckInput[] = await Promise.all(
        items.map(async ({ name }): Promise<WorkshopLinkCheckInput> => {
            try {
                const inspection = await inspectMaterializeSlot(
                    nodeLinkFs,
                    join(materialization.outDir!, name),
                    join(distRoot, name),
                    {
                        platform,
                        readMarker,
                        readCopyMarker: (slotDir) =>
                            readCopySlotMarker(
                                promisesFileSystem,
                                copyMarkerPath(slotDir),
                            ),
                        copyIdentity: { projectId, itemId: name },
                    },
                );
                return {
                    item: name,
                    state:
                        inspection.state === 'ABSENT'
                            ? 'MISSING_LINK'
                            : inspection.state === 'OK_LINK'
                              ? 'ATTACHED_OK'
                              : inspection.state,
                    detail: inspection.detail,
                    vdfPath: join(distRoot, `${name}.workshop.vdf`),
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                return {
                    item: name,
                    state: 'INSPECT_FAILED',
                    detail: message,
                    vdfPath: join(distRoot, `${name}.workshop.vdf`),
                };
            }
        }),
    );
    return {
        materialization: { ...materialization, targetNonLocal },
        workshopLinks,
    };
}

function readMaterializeFromGlobalConfig(): 'symlink' | 'copy' | undefined {
    try {
        const raw = readFileSync(getConfigPath(), 'utf-8');
        const parsed = JSON.parse(raw) as {
            materialize?: 'symlink' | 'copy';
        };
        return parsed.materialize;
    } catch {
        return undefined;
    }
}

async function runProjectDoctorWithLogger(
    projectPath: string,
    options: ProjectDoctorOptions,
    logger: PzStudioLogger,
): Promise<DoctorReport> {
    const previousProjectDir = getExternalProjectDir();
    setProjectDir(projectPath);
    try {
        return await runProjectDoctorCore(projectPath, {
            settings: legacySettings(),
            logger,
            gameBuild: options.gameBuild,
        });
    } finally {
        setProjectDir(previousProjectDir);
    }
}

export async function runProjectDoctor(
    projectPath: string,
    options: ProjectDoctorOptions = {},
): Promise<DoctorReport> {
    return runProjectDoctorWithLogger(projectPath, options, legacyLogger());
}

export async function runProjectDoctorForEngine(
    projectPath: string,
    options: ProjectDoctorOptions = {},
): Promise<DoctorReport> {
    return runProjectDoctorWithLogger(projectPath, options, engineIo().logger);
}
