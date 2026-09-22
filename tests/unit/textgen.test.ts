import { describe, it, expect } from 'vitest';
import {
    workshopText,
    workshopTextLines,
    modInfoText,
    modInfoTextLines,
} from '../../src/lib/core/textgen';
import type { IProjectConfig } from '../../src/lib/project';

const baseConfig = {
    workshop: {
        title: 'Test Project',
        visibility: 'public',
        tags: ['Build 42', 'Map'],
    },
    mods: {},
    excludes: [],
} as IProjectConfig;

describe('workshopText (pure)', () => {
    it('should emit version, id, title, tags and visibility', () => {
        const config = {
            ...baseConfig,
            workshop: { ...baseConfig.workshop, id: '12345' },
        } as IProjectConfig;

        const text = workshopText(config);
        const lines = text.split('\n');

        expect(lines[0]).toBe('version=1');
        expect(lines).toContain('id=12345');
        expect(lines).toContain('title=Test Project');
        expect(lines).toContain('tags=Build 42;Map');
        expect(lines).toContain('visibility=public');
    });

    it('should exclude the id line when excludeId is set', () => {
        const config = {
            ...baseConfig,
            workshop: { ...baseConfig.workshop, id: '12345' },
        } as IProjectConfig;

        const lines = workshopTextLines(config, { excludeId: true });
        expect(lines.some((l) => l.startsWith('id='))).toBe(false);
    });

    it('should append the title suffix and override visibility (dev branch)', () => {
        const lines = workshopTextLines(baseConfig, {
            overrideVisibility: 'unlisted',
            titleSuffix: ' - dev_branch',
        });

        expect(lines).toContain('title=Test Project - dev_branch');
        expect(lines).toContain('visibility=unlisted');
    });

    it('should append description lines verbatim (CRLF already stripped by caller)', () => {
        const lines = workshopTextLines(baseConfig, {
            descriptionLines: ['Line one', 'Line two', ''],
        });

        expect(lines).toContain('description=Line one');
        expect(lines).toContain('description=Line two');
        expect(lines).toContain('description=');
    });
});

describe('modInfoText (pure)', () => {
    it('should emit the id first and known fields in order', () => {
        const config = {
            ...baseConfig,
            mods: {
                my_mod: {
                    name: 'My Mod',
                    description: 'Does things',
                    author: 'me',
                    pack: ['media/asset.pz'],
                },
            },
        } as unknown as IProjectConfig;

        const lines = modInfoTextLines('my_mod', config);
        expect(lines[0]).toBe('id=my_mod');
        expect(lines[1]).toBe('name=My Mod');
        expect(lines).toContain('description=Does things');
        expect(lines).toContain('pack=media/asset.pz');
    });

    it('should use the prefixed id when provided (dev branch)', () => {
        const config = {
            ...baseConfig,
            mods: { my_mod: { name: 'My Mod' } },
        } as unknown as IProjectConfig;

        const lines = modInfoTextLines('my_mod', config, 'my_mod_dev');
        expect(lines[0]).toBe('id=my_mod_dev');
        expect(lines).toContain('name=My Mod');
    });

    it('should pass through unknown forward-compatible fields', () => {
        const config = {
            ...baseConfig,
            mods: {
                my_mod: { name: 'My Mod', custom_field: 'custom_value' },
            },
        } as unknown as IProjectConfig;

        const text = modInfoText('my_mod', config);
        expect(text).toContain('custom_field=custom_value');
    });

    it('should join array require entries with commas', () => {
        const config = {
            ...baseConfig,
            mods: {
                my_mod: { require: ['ModA', 'ModB'] },
            },
        } as unknown as IProjectConfig;

        expect(modInfoText('my_mod', config)).toContain('require=ModA,ModB');
    });

    it('should return an empty string for an unknown mod', () => {
        expect(modInfoText('nope', baseConfig)).toBe('');
    });
});
