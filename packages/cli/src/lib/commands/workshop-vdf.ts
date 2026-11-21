import { existsSync, type Dirent } from 'fs';
import fsp from 'node:fs/promises';
import { basename, join, relative, resolve } from 'path';
import { CliError } from '../errors';
import { addHelp } from '../help';
import { CliUsageError } from '../parser';
import { registerCommand } from '../registry';
import { info } from '../logger';
import { extractFlag } from '../args';
import { distRootOf, projectDir, resolveProjectConfig } from '../helper';
import { resolveBuildOutputPath, type IProjectConfig } from '@pzstudio/core';
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore - necessary because we can't reliably predict if typescript will resolve this outside src without structural errors in some configs
import workshopVdfSchema from '../../../assets/workshop.vdf.schema.json';
/* eslint-enable @typescript-eslint/ban-ts-comment */

const PREVIEW_NAMES = [
    'preview.gif',
    'preview.png',
    'preview.jpg',
    'preview.jpeg',
];
const PREVIEW_MAX_BYTES = 1024 * 1024;
const DEFAULT_APP_ID = '108600';
const VISIBILITY_TO_CODE: Record<string, string> = {
    public: '0',
    'friends only': '1',
    'friends-only': '1',
    friends: '1',
    private: '2',
    unlisted: '3',
};

interface WorkshopItemJson {
    appid: string;
    publishedfileid: string;
    contentfolder: string;
    previewfile: string;
    title: string;
    description?: string;
    changenote?: string;
    visibility?: string;
}

export interface WorkshopVdfOptions {
    itemDir: string;
    outPath: string;
    login?: string;
    id?: string;
    appid?: string;
    title?: string;
    visibility?: string;
    changenote?: string;
}

export interface WorkshopVdfResult {
    vdfPath: string;
    contentfolder: string;
    publishedfileid: string;
    command: string;
}

interface JsonSchemaSubset {
    type?: string;
    required?: string[];
    properties?: Record<string, JsonSchemaSubset>;
    pattern?: string;
    enum?: string[];
    additionalProperties?: boolean;
}

function validateSchema(
    schema: JsonSchemaSubset,
    value: unknown,
    at = '$',
    errors: string[] = [],
): string[] {
    if (schema.type === 'object') {
        if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
        ) {
            errors.push(`${at}: expected object`);
            return errors;
        }
        const record = value as Record<string, unknown>;
        for (const key of schema.required ?? []) {
            if (!(key in record))
                errors.push(`${at}: missing required field "${key}"`);
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(record)) {
                if (!schema.properties?.[key]) {
                    errors.push(
                        `${at}: field "${key}" is not allowed by the schema`,
                    );
                }
            }
        }
        for (const [key, sub] of Object.entries(schema.properties ?? {})) {
            if (key in record)
                validateSchema(sub, record[key], `${at}.${key}`, errors);
        }
    } else if (schema.type === 'string') {
        if (typeof value !== 'string') {
            errors.push(`${at}: expected string`);
            return errors;
        }
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
            errors.push(
                `${at}: value does not match pattern ${schema.pattern}`,
            );
        }
        if (schema.enum && !schema.enum.includes(value)) {
            errors.push(
                `${at}: "${value}" is not one of [${schema.enum.join(', ')}]`,
            );
        }
    }
    return errors;
}

function parseWorkshopTxt(text: string): Record<string, string> {
    const meta: Record<string, string> = {};
    const description: string[] = [];
    for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const eq = raw.indexOf('=');
        if (eq === -1) continue;
        const key = raw.slice(0, eq).trim();
        const val = raw.slice(eq + 1);
        if (key === 'description') description.push(val);
        else if (!(key in meta)) meta[key] = val;
    }
    if (description.length) meta.description = description.join('\n');
    return meta;
}

function resolveVisibility(raw: string, where: string): string {
    const key = String(raw).trim().toLowerCase();
    if (key in VISIBILITY_TO_CODE) return VISIBILITY_TO_CODE[key];
    if (/^[0-3]$/.test(key)) return key;
    if (where === '--visibility') {
        throw new CliUsageError(
            `Invalid --visibility value '${raw}' (expected one of: public, friends (friends only, friends-only), private, unlisted, or 0-3).`,
        );
    }
    throw new CliError(
        `unknown visibility "${raw}" in ${where} (use: ${Object.keys(VISIBILITY_TO_CODE).join(', ')} or 0-3)`,
    );
}

async function findPreview(dir: string): Promise<string | null> {
    for (const name of PREVIEW_NAMES) {
        const p = join(dir, name);
        if (existsSync(p)) return p;
    }
    return null;
}

async function findModIds(itemDir: string): Promise<string[]> {
    const modsDir = join(itemDir, 'Contents', 'mods');
    const ids: string[] = [];
    let entries: Array<Dirent<string>>;
    try {
        entries = await fsp.readdir(modsDir, { withFileTypes: true });
    } catch {
        return ids;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const infoPath = join(modsDir, entry.name, 'mod.info');
        if (!existsSync(infoPath)) continue;
        const text = await fsp.readFile(infoPath, 'utf8');
        const m = text.match(/^\s*id\s*=\s*(.+?)\s*$/m);
        if (m) ids.push(m[1]);
    }
    return ids;
}

async function existingPublishedId(outPath: string): Promise<string | null> {
    if (!existsSync(outPath)) return null;
    const text = await fsp.readFile(outPath, 'utf8');
    const m = text.match(/"publishedfileid"\s+"(\d+)"/);
    return m && m[1] !== '0' ? m[1] : null;
}

function vdfEscape(s: string): string {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toVdf(obj: Record<string, string>, indent = 0): string {
    const pad = '    '.repeat(indent);
    const width = Math.max(...Object.keys(obj).map((k) => k.length));
    const lines: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
        const gap = ' '.repeat(width - key.length + 1);
        lines.push(`${pad}"${vdfEscape(key)}"${gap}"${vdfEscape(value)}"`);
    }
    return lines.join('\n');
}

export async function generateWorkshopVdf(
    opts: WorkshopVdfOptions,
): Promise<WorkshopVdfResult> {
    const itemDir = resolve(opts.itemDir);
    if (!existsSync(itemDir)) {
        throw new CliError(`item folder not found: ${itemDir}`);
    }
    const contentDir = join(itemDir, 'Contents');
    if (!existsSync(contentDir)) {
        throw new CliError(
            `no Contents/ folder in "${itemDir}" - a PZ workshop item needs Contents/mods/<modid>`,
        );
    }
    const outPath = resolve(opts.outPath);

    const modIds = await findModIds(itemDir);
    const txtPath = join(itemDir, 'workshop.txt');
    let meta: Record<string, string> = {};
    if (existsSync(txtPath)) {
        meta = parseWorkshopTxt(await fsp.readFile(txtPath, 'utf8'));
    }
    const title = opts.title ?? meta.title;
    if (!title) {
        throw new CliError(
            'no title: pass --title or add title= to workshop.txt',
        );
    }
    const visibility = opts.visibility
        ? resolveVisibility(opts.visibility, '--visibility')
        : meta.visibility
          ? resolveVisibility(meta.visibility, 'workshop.txt')
          : undefined;
    let description: string | undefined;
    if (existsSync(join(itemDir, 'description.txt'))) {
        description = (
            await fsp.readFile(join(itemDir, 'description.txt'), 'utf8')
        )
            .replace(/\r\n/g, '\n')
            .replace(/\n+$/, '');
    } else if (meta.description) {
        description = meta.description;
    }

    const previewPath = await findPreview(itemDir);
    if (!previewPath) {
        throw new CliError(
            `no preview file in "${itemDir}" (looked for: ${PREVIEW_NAMES.join(', ')})`,
        );
    }
    const previewSize = (await fsp.stat(previewPath)).size;
    if (previewSize >= PREVIEW_MAX_BYTES) {
        throw new CliError(
            `${previewPath} is ${(previewSize / 1024 / 1024).toFixed(2)} MB; SteamCMD previews must be < 1 MB`,
        );
    }

    const publishedfileid =
        opts.id ?? (await existingPublishedId(outPath)) ?? '0';
    if (
        modIds.length &&
        (description === undefined || !/Workshop ID:/i.test(description))
    ) {
        const footer = [
            `Workshop ID: ${publishedfileid === '0' ? '' : publishedfileid}`,
            ...modIds.map((id) => `Mod ID: ${id}`),
        ].join('\n');
        description =
            description === undefined ? footer : `${description}\n\n${footer}`;
    }

    const contentfolder = resolve(contentDir);
    const json: WorkshopItemJson = {
        appid: opts.appid ?? DEFAULT_APP_ID,
        publishedfileid,
        contentfolder,
        previewfile: resolve(previewPath),
        title,
    };
    if (description !== undefined) json.description = description;
    if (visibility !== undefined) json.visibility = visibility;
    if (opts.changenote) json.changenote = opts.changenote;

    const errors = validateSchema(workshopVdfSchema, { workshopitem: json });
    if (errors.length) {
        throw new CliError(
            `workshop item JSON does not satisfy the schema:\n  ${errors.join('\n  ')}`,
        );
    }

    const rel = relative(contentfolder, outPath);
    if (rel === '' || (!rel.startsWith('..') && !isAbsoluteRel(rel))) {
        throw new CliError(
            `the VDF must be written outside contentfolder (${contentfolder}): SteamCMD uploads everything under contentfolder`,
        );
    }

    const vdf = `"workshopitem"\n{\n${toVdf(json as unknown as Record<string, string>)}\n}\n`;
    await fsp.writeFile(outPath, vdf, 'utf8');

    const command = `steamcmd +login ${opts.login ?? '<user>'} +workshop_build_item "${outPath}" +quit`;
    return { vdfPath: outPath, contentfolder, publishedfileid, command };
}

function isAbsoluteRel(rel: string): boolean {
    return /^[a-zA-Z]:[/\\]/.test(rel) || rel.startsWith('\\\\');
}

export async function workshopVdfCmd(): Promise<void> {
    const projectConfig = resolveProjectConfig();
    if (!projectConfig) {
        throw new CliError('No pzstudio project found.');
    }
    const config = projectConfig as IProjectConfig;

    const distRoot = distRootOf(projectDir());
    const anchoredConfig = { ...config, outdir: distRoot };
    const itemFlag = extractFlag('item');
    const itemDir = itemFlag
        ? resolve(itemFlag)
        : resolveBuildOutputPath(anchoredConfig, 'main');
    const outFlag = extractFlag('out');
    const outPath = outFlag
        ? resolve(outFlag)
        : join(distRoot, `${basename(itemDir)}.workshop.vdf`);

    const result = await generateWorkshopVdf({
        itemDir,
        outPath,
        login: extractFlag('login'),
        id: extractFlag('id'),
        appid: extractFlag('appid'),
        title: extractFlag('title'),
        visibility: extractFlag('visibility'),
        changenote: extractFlag('changenote'),
    });
    info(`Wrote ${result.vdfPath}`);
    info(
        `Upload with (run it yourself — pzstudio never executes third-party tools):`,
    );
    info(result.command);
}

addHelp(
    'workshop-vdf',
    `Generate a SteamCMD workshop.vdf for a built workshop item.

    Generates the VDF (schema-validated, absolute contentfolder) and PRINTS
    the exact steamcmd upload command — pzstudio never executes third-party
    tools; you run the upload yourself.

    Usages:
        pzstudio workshop-vdf                   - Generate for the built main item.
        pzstudio workshop-vdf --item <dir>      - Generate for an explicit item folder.
        pzstudio workshop-vdf --out <file>      - Choose the output .vdf path.
        pzstudio workshop-vdf --login <user>    - Put your Steam user into the printed command.
        pzstudio workshop-vdf --id <n>          - Set publishedfileid (default: reuse the out file's, else 0).

    Flags:
        --item <dir>                 - Workshop item folder (default: the built main item).
        --out <file>                 - Output .vdf path (default: dist/<Item>.workshop.vdf).
        --login <user>               - Steam login name for the printed command.
        --id <n>                     - publishedfileid ("0" = new item).
        --appid <n>                  - Game app id (default: 108600).
        --title <text>               - Override the title.
        --visibility <v>             - Override visibility: public | friends | private | unlisted | 0-3.
        --changenote <text>          - Optional update note.
        --verbose                    - Enable diagnostic output.`,
);

registerCommand({
    name: 'workshop-vdf',
    summary:
        'Generate a SteamCMD workshop.vdf for a built item (prints the upload command).',
    silent: true,
    flags: [
        { name: 'item' },
        { name: 'out' },
        { name: 'login' },
        { name: 'id' },
        { name: 'appid' },
        { name: 'title' },
        { name: 'visibility' },
        { name: 'changenote' },
    ],
    run: () => workshopVdfCmd(),
});
