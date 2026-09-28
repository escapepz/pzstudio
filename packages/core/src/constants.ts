import { TemplateCategory, ITemplateConfig } from './project';

/**
 * File extensions that must never be treated as text when doing
 * content replacements (e.g. mod id renames). Reading these as utf-8
 * and writing them back would silently corrupt the files.
 */
export const BINARY_FILE_EXTENSIONS = new Set([
    '.bmp',
    '.dds',
    '.jpg',
    '.jpeg',
    '.mp3',
    '.ogg',
    '.otf',
    '.pal',
    '.png',
    '.tga',
    '.ttf',
    '.vox',
    '.wav',
    '.webp',
]);

export const DEFAULT_TEMPLATES: Record<TemplateCategory, ITemplateConfig> = {
    project: {
        url: 'https://github.com/escapepz/pzstudio-template-project.git',
        ref: '42.17.0',
    },
    mod: {
        url: 'https://github.com/escapepz/pzstudio-template-mod.git',
        ref: '42.17.0',
    },
    workshop: {
        url: 'https://github.com/escapepz/pzstudio-template-workshop.git',
        ref: '42.0',
    },
    language: {
        url: 'https://github.com/escapepz/pzstudio-template-language.git',
        ref: '42.13.1',
    },
};
