import { describe, expect, it } from 'vitest';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateWorkshopVdf } from '../../packages/cli/src/lib/commands/workshop-vdf';

let root: string;
let itemDir: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pz-vdf-'));
    itemDir = join(root, 'Item');
    mkdirSync(join(itemDir, 'Contents', 'mods', 'my_mod'), { recursive: true });
    writeFileSync(
        join(itemDir, 'workshop.txt'),
        'title=Item\nvisibility=unlisted\n',
    );
    writeFileSync(join(itemDir, 'description.txt'), 'A mod.\nSecond line.\n');
    writeFileSync(join(itemDir, 'preview.png'), Buffer.alloc(64, 1));
    writeFileSync(
        join(itemDir, 'Contents', 'mods', 'my_mod', 'mod.info'),
        'name=my_mod\nid=my_mod\n',
    );
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('generateWorkshopVdf', () => {
    it('golden: writes the VDF outside the item dir with absolute contentfolder + PZ footer', async () => {
        const outPath = join(root, 'Item.workshop.vdf');
        const res = await generateWorkshopVdf({ itemDir, outPath });

        expect(res.vdfPath).toBe(outPath);
        expect(existsSync(outPath)).toBe(true);
        const text = readFileSync(outPath, 'utf-8');
        expect(text.startsWith('"workshopitem"\n{\n')).toBe(true);

        // contentfolder: ABSOLUTE, points at the item's Contents folder.
        // VDF values escape backslashes SteamCMD-style (\\), so unescape
        // before comparing with the real path.
        const cf = /"contentfolder"\s+"([^"]+)"/
            .exec(text)![1]
            .replace(/\\\\/g, '\\');
        expect(cf).toBe(resolve(join(itemDir, 'Contents')));
        expect(cf.endsWith('\\Contents') || cf.endsWith('/Contents')).toBe(
            true,
        );

        // Footer: Workshop ID empty until first upload, one Mod ID per mod.
        expect(text).toContain('Workshop ID: \n');
        expect(text).toContain('Mod ID: my_mod');
        // Description body + footer compose the description value (VDF
        // quoted values keep raw newlines, like SteamCMD's own writer).
        expect(text).toContain('A mod.');
        expect(text).toContain('Second line.');

        // Printed steamcmd command carries the quoted VDF path.
        expect(res.command).toBe(
            `steamcmd +login <user> +workshop_build_item "${outPath}" +quit`,
        );
    });

    it('preview larger than 1 MB is refused with the size in the message', async () => {
        writeFileSync(
            join(itemDir, 'preview.png'),
            Buffer.alloc(1024 * 1024 + 1, 1),
        );
        await expect(
            generateWorkshopVdf({ itemDir, outPath: join(root, 'o.vdf') }),
        ).rejects.toThrow(/MB/);
    });

    it('missing title fails with guidance', async () => {
        rmSync(join(itemDir, 'workshop.txt'));
        await expect(
            generateWorkshopVdf({ itemDir, outPath: join(root, 'o.vdf') }),
        ).rejects.toThrow(/title/i);
    });

    it('schema violations list the offending field (non-ASCII title)', async () => {
        writeFileSync(join(itemDir, 'workshop.txt'), 'title=Ünïcode\n');
        await expect(
            generateWorkshopVdf({ itemDir, outPath: join(root, 'o.vdf') }),
        ).rejects.toThrow(/title/);
    });

    it('out inside contentfolder is refused (SteamCMD uploads everything under it)', async () => {
        await expect(
            generateWorkshopVdf({
                itemDir,
                outPath: join(itemDir, 'Contents', 'leak.vdf'),
            }),
        ).rejects.toThrow(/outside contentfolder/i);
    });

    it('reuses the publishedfileid from an existing out VDF', async () => {
        const outPath = join(root, 'Item.workshop.vdf');
        writeFileSync(
            outPath,
            '"workshopitem"\n{\n    "publishedfileid"  "123456"\n}\n',
        );
        const res = await generateWorkshopVdf({ itemDir, outPath });
        expect(res.publishedfileid).toBe('123456');
    });

    it('the command module never spawns a process (product boundary)', () => {
        const src = readFileSync(
            resolve(
                __dirname,
                '../../packages/cli/src/lib/commands/workshop-vdf.ts',
            ),
            'utf-8',
        );
        expect(src).not.toContain('child_process');
        expect(src).not.toContain('spawn');
        expect(src).not.toContain('exec(');
        // And the command is wired into the CLI entry.
        const cli = readFileSync(
            resolve(__dirname, '../../packages/cli/src/lib/cli.ts'),
            'utf-8',
        );
        expect(cli).toContain("import './commands/workshop-vdf'");
    });
});
