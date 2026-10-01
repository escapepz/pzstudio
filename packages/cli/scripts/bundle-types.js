'use strict';

/**
 * Makes the shipped TypeScript declarations self-contained (REL-1C).
 *
 * `tsc` emits the dist declaration files whose public surface re-exports
 * types from
 * workspace packages (@pzstudio/core, @pzstudio/platform) and from the
 * inlined public dep `commander`. None of those ship with the published
 * artifact, so an isolated consumer compile would fail with TS2307. This
 * script vendors their declaration trees into dist/vendor/ and rewrites
 * the import specifiers to relative paths — the declaration-level mirror
 * of what scripts/bundle.js does for the runtime.
 *
 * Gate: after the rewrite, no shipped .d.ts may import a bare specifier
 * that is not a Node builtin. This keeps the "isolated NodeNext consumer
 * compiles" acceptance check honest instead of trusting tsc output.
 */

const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const VENDOR = path.join(DIST, 'vendor');

// Payload directories under dist/ that never contain declarations. The
// vendor tree itself IS walked: its files need the same specifier rewrite
// (e.g. vendored core declarations import @pzstudio/platform).
const SKIP_DIRS = new Set(['.template-legacy', 'scripts']);

const NODE_BUILTINS = new Set([
    'assert',
    'buffer',
    'child_process',
    'console',
    'constants',
    'crypto',
    'dns',
    'events',
    'fs',
    'fs/promises',
    'http',
    'https',
    'module',
    'net',
    'os',
    'path',
    'path/posix',
    'path/win32',
    'perf_hooks',
    'process',
    'querystring',
    'readline',
    'stream',
    'string_decoder',
    'timers',
    'tls',
    'tty',
    'url',
    'util',
    'v8',
    'vm',
    'worker_threads',
    'zlib',
]);

/** Declaration sources to vendor, keyed by the specifier they rewrite to. */
const VENDORED = {
    '@pzstudio/core': path.join(__dirname, '..', '..', 'core', 'dist'),
    '@pzstudio/platform': path.join(__dirname, '..', '..', 'platform', 'dist'),
    commander: path.join(path.dirname(require.resolve('commander')), 'typings'),
};

function toPosix(p) {
    return p.split(path.sep).join('/');
}

function walkDeclarations(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walkDeclarations(path.join(dir, entry.name), out);
        } else if (entry.name.endsWith('.d.ts')) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

function copyDeclarations(src, dest, label) {
    const files = walkDeclarations(src);
    if (files.length === 0) {
        console.error(
            `bundle-types: no declarations found for ${label} at ${src}`,
        );
        console.error('Build the workspace packages first (pnpm build order).');
        process.exit(1);
    }
    for (const file of files) {
        const rel = path.relative(src, file);
        const target = path.join(dest, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file, target);
    }
    console.log(
        `bundle-types: vendored ${files.length} declaration(s) for ${label}`,
    );
}

function main() {
    fs.rmSync(VENDOR, { recursive: true, force: true });

    for (const [specifier, source] of Object.entries(VENDORED)) {
        copyDeclarations(source, path.join(VENDOR, specifier), specifier);
    }

    // Rewrite package-name specifiers to relative vendor paths. The '.js'
    // extension is intentional: NodeNext maps it onto the sibling '.d.ts'.
    const shipped = walkDeclarations(DIST);
    for (const file of shipped) {
        const fileDir = toPosix(path.dirname(file));
        const distPosix = toPosix(DIST);
        const relToDist = path.posix.relative(fileDir, distPosix);
        let content = fs.readFileSync(file, 'utf8');
        let changed = false;
        for (const specifier of Object.keys(VENDORED)) {
            const vendorEntry = `vendor/${specifier}/index.js`;
            const target =
                relToDist === ''
                    ? `./${vendorEntry}`
                    : `${relToDist}/${vendorEntry}`;
            for (const quote of ["'", '"']) {
                const needle = `${quote}${specifier}${quote}`;
                if (content.includes(needle)) {
                    content = content
                        .split(needle)
                        .join(`${quote}${target}${quote}`);
                    changed = true;
                }
            }
        }
        if (changed) fs.writeFileSync(file, content, 'utf8');
    }

    // Gate: no shipped declaration (ours or vendored) may depend on a
    // package that does not ship with the artifact.
    const offenders = [];
    const specifierRe = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
    for (const file of shipped) {
        const content = fs.readFileSync(file, 'utf8');
        let match;
        while ((match = specifierRe.exec(content)) !== null) {
            const spec = match[1];
            if (spec.startsWith('.')) continue;
            if (spec.startsWith('node:')) continue;
            if (NODE_BUILTINS.has(spec)) continue;
            offenders.push(`${toPosix(path.relative(DIST, file))}: '${spec}'`);
        }
    }
    if (offenders.length > 0) {
        console.error(
            'bundle-types: shipped declarations still reference packages that do not ship:',
        );
        for (const line of offenders) console.error(`  ${line}`);
        console.error(
            'Vendor the declarations or stop leaking the type into the public surface (REL-1C).',
        );
        process.exit(1);
    }

    console.log(
        `bundle-types: ${shipped.length} shipped declaration(s) are self-contained`,
    );
}

main();
