import fs from 'fs';
import { basename, dirname, join } from 'path';
import type { Dirent } from 'fs';

export type MutationLeafMode = 'write' | 'delete';

export interface CliMutationRouteOptions {
    outputRoot?: string;
}

function pathSegments(path: string): string[] {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment !== '');
}

function segmentsBelow(root: string, candidate: string): string[] | null {
    const rootSegments = pathSegments(root);
    const candidateSegments = pathSegments(candidate);
    if (candidateSegments.length <= rootSegments.length) {
        return null;
    }
    for (let i = 0; i < rootSegments.length; i += 1) {
        const rootSegment = rootSegments[i];
        const candidateSegment = candidateSegments[i];
        const equal =
            i === 0 && /^[a-zA-Z]:$/.test(rootSegment)
                ? rootSegment.toLowerCase() === candidateSegment.toLowerCase()
                : rootSegment === candidateSegment;
        if (!equal) {
            return null;
        }
    }
    return candidateSegments.slice(rootSegments.length);
}

function isNoSuchEntryError(e: unknown): boolean {
    const err = e as { code?: string; message?: string } | undefined;
    return (
        err?.code === 'ENOENT' ||
        (err?.message ?? '').includes('ENOENT') ||
        (err?.message ?? '').includes('no such file or directory')
    );
}

function listRouteDirectorySync(
    operation: string,
    targetPath: string,
    dir: string,
): Dirent[] | null {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        if (isNoSuchEntryError(e)) {
            return null;
        }
        throw new Error(
            `Cannot authorize ${operation} '${targetPath}': listing '${dir}' failed (${
                e instanceof Error ? e.message : String(e)
            }) — the route below the build output root could not be verified.`,
            { cause: e },
        );
    }
}

function lookupRouteEntrySync(
    parentDir: string,
    entries: Dirent[],
    name: string,
): Dirent | null {
    const exact = entries.find((entry) => entry.name === name);
    if (exact) {
        return exact;
    }
    const lower = name.toLowerCase();
    const variants = entries.filter(
        (entry) => entry.name.toLowerCase() === lower,
    );
    if (variants.length !== 1) {
        return null;
    }
    try {
        fs.statSync(join(parentDir, name));
    } catch {
        return null;
    }
    return variants[0];
}

export function aliasRouteError(
    operation: string,
    targetPath: string,
    outputRoot: string,
    componentName: string,
): Error {
    return new Error(
        `Refusing ${operation} '${targetPath}': '${componentName}' on the route below the build output root '${outputRoot}' is a symbolic link, so the mutation would apply to content outside the generated output. Remove the link or correct the build's output configuration.`,
    );
}

export function assertNoAliasRouteSync(
    outputRoot: string | undefined,
    targetPath: string,
    leafMode: MutationLeafMode,
    operation: string,
): void {
    if (!outputRoot) {
        return;
    }
    const below = segmentsBelow(outputRoot, targetPath);
    if (!below) {
        throw new Error(
            `Refusing ${operation} '${targetPath}': the target is not inside the configured build output root '${outputRoot}'.`,
        );
    }
    let current = outputRoot;
    for (let i = 0; i < below.length; i += 1) {
        const name = below[i];
        const isLeaf = i === below.length - 1;
        if (isLeaf && leafMode === 'delete') {
            return;
        }
        const entries = listRouteDirectorySync(operation, targetPath, current);
        if (entries === null) {
            return;
        }
        const entry = lookupRouteEntrySync(current, entries, name);
        if (!entry) {
            return;
        }
        if (entry.isSymbolicLink()) {
            throw aliasRouteError(
                operation,
                targetPath,
                outputRoot,
                entry.name,
            );
        }
        if (isLeaf || !entry.isDirectory()) {
            return;
        }
        current = join(current, entry.name);
    }
}

export function assertNoAliasDestinationEntry(
    destPath: string,
    outputRoot: string,
    operation: string,
): void {
    const parentDir = dirname(destPath);
    const name = basename(destPath);
    const entries = listRouteDirectorySync(operation, destPath, parentDir);
    if (entries === null) {
        return;
    }
    const entry = lookupRouteEntrySync(parentDir, entries, name);
    if (entry?.isSymbolicLink()) {
        throw aliasRouteError(operation, destPath, outputRoot, entry.name);
    }
}
