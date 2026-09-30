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

export interface ITemplateConfig {
    url: string;
    ref?: string;
}

export interface GlobalConfig {
    templates: Partial<Record<TemplateCategory, ITemplateConfig>>;
    outdir?: string;
    useSymlinks?: boolean;

    /**
     * Same shape and meaning as IProjectConfig.experimental. An explicit
     * project.json setting always wins over this one; absent in both
     * layers means disabled.
     */
    experimental?: {
        integration?: boolean;
    };
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
