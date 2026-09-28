/**
 * The public project.json contract.
 *
 * Loading a project follows one pipeline — detectVersion → migrateProject →
 * validate → normalize — so host packages never re-implement legacy
 * handling. The filesystem comes in as an injected @pzstudio/platform
 * ProjectFileSystem; core does not know whether the URIs resolve to local
 * disk, a workspace VFS or anything else.
 */
import type { ProjectFileSystem } from '@pzstudio/platform';
import { IProjectConfig } from './project';
import { PROJECT_SCHEMA_VERSION } from './schema-version';
import { ValidationContext, validateProject } from './validation';
import { migration } from './migration';
import { applyProjectDefaults } from './defaults';

/** Base class for every project.json loading failure. */
export class ProjectLoadError extends Error {}

/** The file could not be read or its content is not valid JSON. */
export class ProjectParseError extends ProjectLoadError {}

/** The file was written by a different (usually newer) schema version. */
export class ProjectVersionError extends ProjectLoadError {}

/** The project content is structurally invalid (see the formatted errors). */
export class ProjectValidationError extends ProjectLoadError {}

/**
 * Reads the schemaVersion of a raw parsed project.json. The field is
 * optional: files without it predate versioning and are treated as
 * version 1. A non-numeric value is treated as absent.
 */
export function detectVersion(raw: unknown): number {
    if (
        raw &&
        typeof raw === 'object' &&
        typeof (raw as Record<string, unknown>).schemaVersion === 'number'
    ) {
        return (raw as Record<string, number>).schemaVersion;
    }
    return 1;
}

export interface MigratedProject {
    /** The migrated config, stamped with the current schemaVersion. */
    config: IProjectConfig;
    fromVersion: number;
    toVersion: number;
    /** Human-readable reason of each applied migration step, in order. */
    migrations: string[];
}

/**
 * Pure: brings a raw project.json content up to the current schema version
 * through the migration chain, or throws ProjectVersionError for files the
 * current tooling cannot read (unknown older/newer versions).
 */
export function migrateProject(raw: unknown): MigratedProject {
    const fromVersion = detectVersion(raw);
    if (fromVersion < 1 || fromVersion > PROJECT_SCHEMA_VERSION) {
        throw new ProjectVersionError(
            `Unsupported project.json schemaVersion: ${fromVersion} ` +
                `(this tool supports 1..${PROJECT_SCHEMA_VERSION}). ` +
                `Upgrade PZ Studio to open this project.`,
        );
    }

    let config = raw;
    const migrations: string[] = [];

    if (fromVersion < 2) {
        // v1 → v2: normalize legacy shapes, then stamp the version field.
        const check = migration.checkProject(config);
        if (check.needsMigration) {
            migrations.push(check.reason ?? 'legacy project shape');
            config = migration.upgradeProject(config);
        }
        config = { ...(config as object), schemaVersion: 2 };
    }

    return {
        config: config as IProjectConfig,
        fromVersion,
        toVersion: PROJECT_SCHEMA_VERSION,
        migrations,
    };
}

export interface LoadedProject {
    /** The URI the project was loaded from, exactly as passed in. */
    uri: string;
    /** The migrated, validated config with defaults applied. */
    config: IProjectConfig;
    /** The schemaVersion the content is now at (always the current one). */
    version: number;
    /** Present when the load applied at least one migration step. */
    migrations?: string[];
}

/** Extracts a display name from a URI without assuming a path module. */
function basenameOf(uri: string): string {
    const slash = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'));
    return slash === -1 ? uri : uri.substring(slash + 1);
}

/**
 * Loads, migrates, validates and normalizes a project.json. Throws a
 * ProjectLoadError subclass on unreadable files, invalid JSON, unsupported
 * versions or validation failures.
 */
export async function loadProject(
    fs: ProjectFileSystem,
    projectUri: string,
): Promise<LoadedProject> {
    let raw: unknown;
    try {
        const bytes = await fs.read(projectUri);
        raw = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch (err) {
        if (err instanceof SyntaxError) {
            throw new ProjectParseError(
                `Failed to parse '${basenameOf(projectUri)}': ${(err as Error).message}. ` +
                    `Fix the JSON syntax and try again.`,
                { cause: err },
            );
        }
        if (err instanceof ProjectLoadError) throw err;
        throw new ProjectParseError(
            `Failed to read '${projectUri}': ${(err as Error).message}`,
            { cause: err },
        );
    }

    const migrated = migrateProject(raw);
    const context = new ValidationContext(basenameOf(projectUri));
    validateProject(migrated.config, context);
    if (context.hasErrors()) {
        throw new ProjectValidationError(
            `Validation failed for ${basenameOf(projectUri)}:\n${context.formatErrors()}`,
        );
    }

    return {
        uri: projectUri,
        config: applyProjectDefaults(migrated.config),
        version: migrated.toVersion,
        migrations:
            migrated.migrations.length > 0 ? migrated.migrations : undefined,
    };
}

/**
 * Serializes a project config as the current schema version and writes it
 * through the injected filesystem. Unknown fields are preserved; callers
 * that need read-modify-write semantics should loadProject first.
 */
export async function saveProject(
    fs: ProjectFileSystem,
    projectUri: string,
    config: IProjectConfig,
): Promise<void> {
    const stamped = { ...config, schemaVersion: PROJECT_SCHEMA_VERSION };
    const bytes = new TextEncoder().encode(JSON.stringify(stamped, null, 4));
    await fs.write(projectUri, bytes);
}
