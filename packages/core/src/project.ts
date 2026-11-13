export type WorkshopVisibility =
    | 'public'
    | 'friendsOnly'
    | 'private'
    | 'unlisted';

export type WorkshopTags =
    | 'Build 40'
    | 'Build 41'
    | 'Build 42'
    | 'Animals'
    | 'Audio'
    | 'Balance'
    | 'Building'
    | 'Clothing/Armor'
    | 'Farming'
    | 'Food'
    | 'Framework'
    | 'Hardmode'
    | 'Interface'
    | 'Items'
    | 'Language/Translation'
    | 'Literature'
    | 'Map'
    | 'Military'
    | 'Misc'
    | 'Models'
    | 'Multiplayer'
    | 'Pop Culture'
    | 'Realistic'
    | 'Silly/Fun'
    | 'Skills'
    | 'Textures'
    | 'Traits'
    | 'Vehicles'
    | 'QoL'
    | 'WIP'
    | 'Weapons';

export interface IWorkshopConfig {
    id?: number;
    title: string;
    description?: string;
    visibility: WorkshopVisibility;
    tags: WorkshopTags[];
}

export interface IModConfig {
    name: string;
    description: string | string[];
    author?: string;
    modversion?: string;
    poster?: string | string[];
    icon?: string;
    require?: string | string[];
    incompatible?: string | string[];
    loadModAfter?: string | string[];
    loadModBefore?: string | string[];
    pack?: string | string[];
    tiledef?: string | string[];
    category?: string;
    url?: string;
    versionMin?: string;
    versionMax?: string;

    /**
     * Custom build flags for this mod.
     * Omitting a flag uses the default (auto-if-missing) behaviour.
     */
    build?: {
        /**
         * Controls whether mod.info is auto-generated from project.json.
         *
         * - "auto-if-missing" (default) — generate only if mod.info is not already present in the source/output
         * - "auto"                      — generate mod.info from project.json (overwrite existing)
         * - "skip"                      — never generate; use whatever file exists in the mod folder
         */
        modInfo?: 'auto' | 'skip' | 'auto-if-missing';
        /**
         * Marks the mod as a development-only mod: it is copied into the
         * development (dev_branch) workshop output but skipped by the
         * production (main) build.
         */
        devOnly?: boolean;
    };
}

export type TemplateCategory = 'project' | 'mod' | 'workshop' | 'language';

/**
 * Build targets for a single build invocation.
 * "both" produces the main (production) and the development (dev_branch)
 * outputs in one run.
 */
export type ProjectBuildTarget = 'production' | 'development' | 'both';

/**
 * How the materialize step exposes each built item to the game from the
 * canonical `dist/` output (dist-always amendment, 2026-11-12):
 * 'symlink' creates/maintains a junction `<outdir>/<Item>` →
 * `<root>/dist/<Item>` (the default — zero-cost under watch); 'copy'
 * maintains a verified, reconciled real copy. There is deliberately no
 * 'none' value: omitting `outdir` (or passing --no-materialize) is the
 * only way to skip deployment.
 */
export type MaterializeMode = 'symlink' | 'copy';

export interface ITemplateConfig {
    url: string;
    ref?: string;
}

export interface GlobalConfig {
    templates: Partial<Record<TemplateCategory, ITemplateConfig>>;
    outdir?: string;
    useSymlinks?: boolean;

    /**
     * Machine-level materialize fallback for the dist-always output model
     * (flat key, per the global config's flat shape). Used when
     * `project.json` carries no `build.materialize`; the default is
     * 'symlink'. Lets a developer on a mount where junctions cannot be
     * created (WSL/SMB) opt into 'copy' once, without dirtying tracked
     * project files.
     */
    materialize?: MaterializeMode;

    /**
     * Machine-level workshop root for the dist model's per-item junctions
     * (`<workshopRoot>/<Item>` -> `<project>/dist/<Item>`). Absent means
     * the factory default (`%USERPROFILE%\Zomboid\Workshop`); the
     * `PZSTUDIO_WORKSHOP_ROOT` env var wins over this field.
     */
    workshopRoot?: string;

    /**
     * Same shape and meaning as IProjectConfig.experimental. An explicit
     * project.json setting always wins over this one; absent in both
     * layers means disabled.
     */
    experimental?: {
        integration?: boolean;
    };

    /**
     * Offline usage-log settings. Absent means enabled; an explicit
     * enabled: false is sticky across versions and hosts.
     */
    usageLog?: UsageLogConfig;
}

export interface UsageLogConfig {
    enabled?: boolean;
}

export interface IVsCodeSettings {
    templates?: Partial<Record<TemplateCategory, ITemplateConfig>>;
    outdir?: string;
    useSymlinks?: boolean;
}

export interface IProjectConfig {
    workshop: IWorkshopConfig;
    mods: { [modId: string]: IModConfig };
    outdir?: string;

    excludes?: string[];

    /**
     * Version of the project.json schema this file was written against.
     * Absent means version 1 (pre-schemaVersion files); the loader stamps
     * the current version when migrating and saving.
     */
    schemaVersion?: number;

    /**
     * Project-level build behaviour.
     */
    build?: {
        /**
         * Which workshop outputs `pzstudio build` produces when no target
         * flag is given. An explicit CLI flag still wins.
         */
        target?: ProjectBuildTarget;
        /**
         * How built items are exposed to the game from `dist/`:
         * 'symlink' (default) junctions each item into the deployment
         * root, 'copy' maintains a reconciled real copy there. The
         * machine-level config (~/.pzstudio) may carry the same flat
         * 'materialize' key as a fallback; a per-invocation
         * --materialize flag wins over both. Omitting `outdir` disables
         * deployment entirely — there is no 'none' value.
         */
        materialize?: MaterializeMode;
    };

    /**
     * The Project Zomboid build line this project targets, e.g. "42.x".
     * Advisory only: doctor/build warn when the running game build falls
     * outside it, but nothing is blocked.
     */
    pzBuildCompatibility?: string;

    /**
     * Opt-in switches for experimental behaviour. Nothing here is enabled
     * by default; every switch must be turned on explicitly (project.json
     * first, global config second, disabled when absent in both).
     */
    experimental?: {
        /**
         * Injects experimental helper scripts (junction setup etc.) into
         * the project's package.json on new/add/delete/rename.
         * BREAKING (CLI-10): defaults to false; the previous silent
         * injection requires an explicit opt-in now.
         */
        integration?: boolean;
    };
}
