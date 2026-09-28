const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

async function run() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        outfile: 'dist/extension.js',
        // @parcel/watcher is the CLI watch command's native watcher: the api
        // surface inlines the whole command registry, so keep the require
        // external (the command loads it lazily and the extension never
        // invokes it — the auto-sync uses the VS Code FileSystemWatcher).
        external: ['vscode', '@parcel/watcher'],
        format: 'cjs',
        platform: 'node',
        sourcemap: true,
        minify: !isWatch,
    });

    if (isWatch) {
        await ctx.watch();
        console.log('Watching...');
    } else {
        try {
            await ctx.rebuild();
            console.log('Build complete.');

            // Copy templates from monorepo root
            const templates = [
                '.template-language',
                '.template-mod',
                '.template-project',
                '.template-workshop',
            ];

            for (const template of templates) {
                const from = path.join(
                    __dirname,
                    '../../../',
                    '.template-legacy/',
                    template,
                );
                const to = path.join(
                    __dirname,
                    '../',
                    '.template-legacy/',
                    template,
                );

                if (fs.existsSync(from)) {
                    console.log(`Syncing ${template}...`);
                    // dereference: follow symlinks instead of writing the
                    // link target as a plain text file
                    fs.cpSync(from, to, { recursive: true, dereference: true });
                }
            }

            // Copy JSON schemas used by the jsonValidation contribution
            const schemasDir = path.join(__dirname, '../schemas');
            fs.mkdirSync(schemasDir, { recursive: true });
            for (const schema of [
                'pzstudio.schema.json',
                'workshop.schema.json',
            ]) {
                fs.copyFileSync(
                    path.join(__dirname, '../../../', schema),
                    path.join(schemasDir, schema),
                );
            }
            console.log('Syncing schemas...');
        } catch (err) {
            console.error('Build failed:', err);
            process.exit(1);
        } finally {
            await ctx.dispose();
        }
    }
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
