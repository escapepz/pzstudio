import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// resolve to repo-root scripts via relative path
const nodeRequire = createRequire(import.meta.url);
const pin = nodeRequire('../../scripts/pin-template-legacy.js');

describe('loadConfig', () => {
    it('loads the four templates with valid modes', () => {
        const cfg = pin.loadConfig();
        expect(cfg.map((c: any) => c.name)).toEqual([
            '.template-project',
            '.template-mod',
            '.template-workshop',
            '.template-language',
        ]);
        expect(
            cfg.every((c: any) => c.mode === 'tag' || c.mode === 'branch'),
        ).toBe(true);
        expect(
            cfg.every((c: any) =>
                c.url.startsWith('https://github.com/escapepz/'),
            ),
        ).toBe(true);
    });
});

describe('parseLsRemoteTags', () => {
    it('splits sha<TAB>ref lines and attaches ^{} peels to their base ref', () => {
        const out = [
            'ce4de87534349852087295069d2e1113137d9831\trefs/tags/42.13.1',
            '9aabe6726adc4789c24b1948b1a8dff01942e12e\trefs/tags/42.13.1^{}',
            'd26a2f800057e33d81e0592774c67dd812500f06\trefs/tags/42.22.0-20261109-1902',
            '75688f88daa9336230a4095156218aead123a82a\trefs/heads/main',
            '75688f88daa9336230a4095156218aead123a82a\tHEAD',
        ].join('\n');
        const entries = pin.parseLsRemoteTags(out);
        const annotated = entries.find(
            (e: any) => e.ref === 'refs/tags/42.13.1',
        );
        expect(annotated.peeledSha).toBe(
            '9aabe6726adc4789c24b1948b1a8dff01942e12e',
        );
        expect(entries.find((e: any) => e.ref === 'HEAD')).toBeTruthy();
    });
});

describe('resolvePin tag mode', () => {
    const entries = pin.parseLsRemoteTags(
        [
            '1111111111111111111111111111111111111111\trefs/tags/42.13.1',
            '2222222222222222222222222222222222222222\trefs/tags/42.13.1^{}',
            '3333333333333333333333333333333333333333\trefs/tags/42.13.1-simple',
            '4444444444444444444444444444444444444444\trefs/tags/42.0',
            '5555555555555555555555555555555555555555\trefs/tags/default',
            '6666666666666666666666666666666666666666\trefs/tags/42.22.0-20261109-1902',
            '7777777777777777777777777777777777777777\trefs/heads/main',
            '7777777777777777777777777777777777777777\tHEAD',
        ].join('\n'),
    );

    it('picks semver-highest numeric tag and uses the peeled sha for annotated tags', () => {
        expect(pin.resolvePin(entries, 'tag')).toEqual({
            sha: '6666666666666666666666666666666666666666',
            source: 'refs/tags/42.22.0-20261109-1902',
        });
    });
    it('suffix tags lose to the plain version', () => {
        const few = pin.parseLsRemoteTags(
            [
                '1111111111111111111111111111111111111111\trefs/tags/42.13.1',
                '2222222222222222222222222222222222222222\trefs/tags/42.13.1^{}',
                '3333333333333333333333333333333333333333\trefs/tags/42.13.1-simple',
            ].join('\n'),
        );
        expect(pin.resolvePin(few, 'tag')!.sha).toBe(
            '2222222222222222222222222222222222222222',
        );
    });
    it('returns undefined when no numeric tag exists', () => {
        const none = pin.parseLsRemoteTags('aaaa\trefs/tags/default');
        expect(pin.resolvePin(none, 'tag')).toBeUndefined();
    });
});

describe('resolvePin branch mode', () => {
    it('uses the HEAD tip sha', () => {
        const entries = pin.parseLsRemoteTags(
            '75688f88daa9336230a4095156218aead123a82a\tHEAD',
        );
        expect(pin.resolvePin(entries, 'branch')).toEqual({
            sha: '75688f88daa9336230a4095156218aead123a82a',
            source: 'HEAD',
        });
    });
});
