'use strict';

/**
 * Builds the self-contained @pzstudio/cli runtime.
 *
 * Two esbuild bundles (CommonJS, node platform): `index.js` is the executable
 * entry (bin) and `api.js` is the embedder surface (hosts/VS Code use
 * `@pzstudio/cli/api`). Everything the CLI needs is inlined EXCEPT the native
 * @parcel/watcher (loaded lazily by `watch` and kept as the one runtime
 * dependency), so the published npm artifact is self-contained on a clean
 * machine — the private `@pzstudio/*` chain and the other public deps are
 * all inside the bundle and are NOT published as installable runtime deps.
 *
 * After building, a mechanical closure gate verifies the invariant from
 * REL-1A:
 *
 *     normalized esbuild externals == package.json.dependencies
 *
 * External specifiers are normalized first (node: specifiers and Node
 * builtins are ignored, subpaths flattened to their package root, relative
 * paths ignored), so the build fails if a bundled dep is still declared OR
 * an external is undeclared — no hand-maintained allow-list.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const PKG = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
);
const OUTDIR = path.join(__dirname, '..', 'dist');

/** Node builtins (with and without the node: prefix) are not npm deps. */
const NODE_BUILTINS = new Set([
    'assert',
    'async_hooks',
    'buffer',
    'child_process',
    'cluster',
    'console',
    'constants',
    'crypto',
    'dgram',
    'diagnostics_channel',
    'dns',
    'domain',
    'events',
    'fs',
    'fs/promises',
    'http',
    'http2',
    'https',
    'module',
    'net',
    'os',
    'path',
    'path/posix',
    'path/win32',
    'perf_hooks',
    'process',
    'punycode',
    'querystring',
    'readline',
    'repl',
    'stream',
    'string_decoder',
    'sys',
    'timers',
    'tls',
    'trace_events',
    'tty',
    'url',
    'util',
    'util/types',
    'v8',
    'vm',
    'wasi',
    'worker_threads',
    'zlib',
]);

/**
 * Normalizes an esbuild external import specifier to a package name, or
 * returns undefined for specifiers that are not npm dependencies (builtins,
 * relative, absolute).
 */
function normalizeExternalPackage(specifier) {
    if (!specifier) return undefined;
    if (specifier.startsWith('node:')) return undefined;
    if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
        return undefined;
    }
    if (NODE_BUILTINS.has(specifier)) return undefined;
    // Flatten scope/pkg/subpath -> scope/pkg and pkg/subpath -> pkg.
    const parts = specifier.split('/');
    if (specifier.startsWith('@')) {
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
    }
    return parts[0];
}

/** Internal @pzstudio packs are always bundled — never allowed as externals. */
function isInternalBundle(specifier) {
    return (
        specifier === '@pzstudio/core' ||
        specifier === '@pzstudio/platform' ||
        specifier === '@pzstudio/platform-node'
    );
}

async function main() {
    const entries = {
        index: path.join(__dirname, '..', 'src', 'index.ts'),
        api: path.join(__dirname, '..', 'src', 'api.ts'),
    };

    // TWO independent bundles. #index is executable-only; /api carries its own
    // copy of the internal singletons (external anchor, transport) so hosts
    // must import @pzstudio/cli/api and never mix the root entry with it.
    const result = await esbuild.build({
        entryPoints: entries,
        outdir: OUTDIR,
        entryNames: '[name]',
        bundle: true,
        platform: 'node',
        format: 'cjs',
        sourcemap: false,
        minify: false,
        // The native watcher is loaded lazily inside watchCmd and remains the
        // CLI's single runtime dependency. Everything else is inlined.
        external: ['@parcel/watcher'],
        metafile: true,
        logLevel: 'info',
    });

    // Closure gate: normalized externals == package.json.dependencies.
    const externals = new Set();
    for (const outputPath of Object.keys(result.metafile.outputs)) {
        const out = result.metafile.outputs[outputPath];
        for (const imp of out.imports || []) {
            const pkg = normalizeExternalPackage(imp.path);
            if (pkg && !isInternalBundle(pkg)) {
                externals.add(pkg);
            }
        }
    }

    const declared = Object.keys(PKG.dependencies || {}).sort();
    const actual = [...externals].sort();

    const asyncMessage =
        '[rel-1a] esbuild externals do not match package.json.dependencies.';
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
        console.error(
            `${asyncMessage}\n  declared dependencies: ${JSON.stringify(declared)}\n  esbuild externals:     ${JSON.stringify(actual)}\n` +
                'Every bundled dep must be removed from dependencies (moved to devDependencies); ' +
                'every external must be a declared runtime dependency. See REL-1A closure invariant.',
        );
        process.exit(1);
    }

    // Persist the metafile so the packlist / THIRD_PARTY_NOTICES tooling can
    // derive exactly which packages were inlined (metafile.inputs, NOT the
    // externals list — externals are precisely what was NOT inlined).
    const metaDir = path.join(__dirname, '..', '.tmp', 'release');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
        path.join(metaDir, 'bundle-metafile.json'),
        JSON.stringify(result.metafile, null, 2),
    );

    console.log(
        `Bundle complete (${PKG.name}): index.js + api.js, externals=${JSON.stringify(actual)}`,
    );
}

main().catch((err) => {
    console.error('Bundle failed:', err);
    process.exit(1);
});
