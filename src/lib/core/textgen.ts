/**
 * Pure text generation for PZ metadata files.
 *
 * This module is deliberately free of any I/O (fs/path/child_process): it
 * takes plain data in and returns strings out, so it can be unit-tested
 * without filesystem fixtures and reused by a browser extension host.
 */
import type { IProjectConfig } from '../project';

export interface WorkshopTextOptions {
    /** Description lines from workshop/description.txt, already newline-split. */
    descriptionLines?: string[];
    overrideVisibility?: string;
    excludeId?: boolean;
    titleSuffix?: string;
}

export function workshopTextLines(
    config: IProjectConfig,
    options: WorkshopTextOptions = {},
): string[] {
    const {
        descriptionLines = [],
        overrideVisibility,
        excludeId = false,
        titleSuffix,
    } = options;

    const lines: string[] = [];

    lines.push(`version=1`);
    if (!excludeId && config.workshop.id)
        lines.push(`id=${config.workshop.id}`);
    if (config.workshop.title)
        lines.push(`title=${config.workshop.title}${titleSuffix ?? ''}`);
    if (config.workshop.tags)
        lines.push(`tags=${config.workshop.tags.join(';')}`);
    if (overrideVisibility || config.workshop.visibility)
        lines.push(
            `visibility=${overrideVisibility ?? config.workshop.visibility}`,
        );

    for (const line of descriptionLines) {
        lines.push(`description=${line}`);
    }

    return lines;
}

export function workshopText(
    config: IProjectConfig,
    options: WorkshopTextOptions = {},
): string {
    return workshopTextLines(config, options).join('\n');
}

export function modInfoTextLines(
    modId: string,
    config: IProjectConfig,
    prefixedId?: string,
): string[] {
    const lines: string[] = [];
    const mod = config.mods[modId];

    if (mod) {
        // id (MUST BE FIRST or near top for PZ)
        lines.push(`id=${prefixedId ?? modId}`);

        // name
        if (mod.name) lines.push(`name=${mod.name}`);

        // description
        if (mod.description) {
            const descLines = Array.isArray(mod.description)
                ? mod.description
                : [mod.description];
            descLines.forEach((d) => lines.push(`description=${d}`));
        }

        // author
        if (mod.author) lines.push(`author=${mod.author}`);

        // modversion
        if (mod.modversion) lines.push(`modversion=${mod.modversion}`);

        // poster
        if (typeof mod.poster === 'object')
            (mod.poster as string[]).forEach((poster) =>
                lines.push(`poster=${poster}`),
            );
        else if (typeof mod.poster === 'string')
            lines.push(`poster=${mod.poster}`);

        // icon
        if (mod.icon) {
            lines.push(`icon=${mod.icon}`);
        }

        // require
        if (typeof mod.require === 'string')
            lines.push(`require=${mod.require}`);
        else if (typeof mod.require === 'object' && mod.require.length > 0)
            lines.push(`require=${(mod.require as string[]).join(',')}`);

        // incompatible
        if (typeof mod.incompatible === 'string')
            lines.push(`incompatible=${mod.incompatible}`);
        else if (
            typeof mod.incompatible === 'object' &&
            mod.incompatible.length > 0
        )
            lines.push(
                `incompatible=${(mod.incompatible as string[]).join(',')}`,
            );

        // loadModAfter
        if (typeof mod.loadModAfter === 'string')
            lines.push(`loadModAfter=${mod.loadModAfter}`);
        else if (
            typeof mod.loadModAfter === 'object' &&
            mod.loadModAfter.length > 0
        )
            lines.push(
                `loadModAfter=${(mod.loadModAfter as string[]).join(',')}`,
            );

        // loadModBefore
        if (typeof mod.loadModBefore === 'string')
            lines.push(`loadModBefore=${mod.loadModBefore}`);
        else if (
            typeof mod.loadModBefore === 'object' &&
            mod.loadModBefore.length > 0
        )
            lines.push(
                `loadModBefore=${(mod.loadModBefore as string[]).join(',')}`,
            );

        // pack
        if (mod.pack) {
            const packs = Array.isArray(mod.pack) ? mod.pack : [mod.pack];
            packs.forEach((p) => {
                lines.push(`pack=${p}`);
            });
        }

        // tiledef
        if (mod.tiledef) {
            const tiledefs = Array.isArray(mod.tiledef)
                ? mod.tiledef
                : [mod.tiledef];
            tiledefs.forEach((t) => {
                lines.push(`tiledef=${t}`);
            });
        }

        // category
        if (mod.category) lines.push(`category=${mod.category}`);

        // url
        if (mod.url) lines.push(`url=${mod.url}`);

        // version
        if (mod.versionMin) lines.push(`versionMin=${mod.versionMin}`);
        // version
        if (mod.versionMax) lines.push(`versionMax=${mod.versionMax}`);

        // Unknown / Forward-compatible fields
        const knownFields = [
            'id',
            'name',
            'description',
            'author',
            'modversion',
            'poster',
            'icon',
            'require',
            'incompatible',
            'loadModAfter',
            'loadModBefore',
            'pack',
            'tiledef',
            'category',
            'url',
            'versionMin',
            'versionMax',
            'build',
        ];
        for (const key in mod) {
            if (!knownFields.includes(key)) {
                lines.push(`${key}=${(mod as any)[key]}`);
            }
        }
    }

    return lines;
}

export function modInfoText(
    modId: string,
    config: IProjectConfig,
    prefixedId?: string,
): string {
    return modInfoTextLines(modId, config, prefixedId).join('\n');
}
