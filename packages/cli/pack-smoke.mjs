#!/usr/bin/env node
/**
 * pack-smoke.mjs — REL-2
 *
 * Isolated smoke test for the packed @pzstudio/cli artifact.
 * Runs in an OS-temp project (never under the repo) so the install has
 * no access to ancestor node_modules / workspaces.
 *
 * Every check runs against the exact tarball bytes produced by
 * pack-artifact.mjs — this script never packs anything itself.
 *
 * Usage: node pack-smoke.mjs <exact-tgz>
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { join, resolve, dirname } from 'path';

const SCRIPT_DIR = dirname(process.argv[1]); // dir of pack-smoke.mjs = packages/cli/
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

const TGZ = process.argv[2];
if (!TGZ) {
    console.error('Usage: node pack-smoke.mjs <exact-tgz>');
    process.exit(1);
}

if (!existsSync(TGZ)) {
    console.error(`Error: tarball not found: ${TGZ}`);
    process.exit(1);
}

const require = createRequire(import.meta.url);

// ─── Helpers ────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
    const defaults = { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' };
    return execSync(cmd, { ...defaults, ...opts });
}

function runOk(cmd, opts = {}) {
    try {
        run(cmd, opts);
        return true;
    } catch (e) {
        console.error(`FAIL: command failed: ${cmd}`);
        if (e.stderr) console.error(String(e.stderr).slice(0, 2000));
        else if (e.message) console.error(String(e.message).slice(0, 2000));
        return false;
    }
}

function tmpDir(label) {
    const os = require('os');
    const base = os.tmpdir();
    let i = 0;
    while (true) {
        const dir = join(base, `pzstudio-smoke-${label}-${Date.now()}-${i++}`);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
            return dir;
        }
    }
}

// ─── Isolated HOME ──────────────────────────────────────────────────────────

// The smoke process runs with an isolated HOME so nothing can touch the
// real ~/.pzstudio; its existence is snapshotted and re-checked at the end.
const os = require('os');
const ISOLATED_HOME = tmpDir('home');
const ISOLATED_USERPROFILE = ISOLATED_HOME;
const ISOLATED_HOMEDRIVE = ISOLATED_HOME.slice(0, 2); // e.g. "C:"
const ISOLATED_HOMEPATH = ISOLATED_HOME.slice(2); // e.g. "\..."

const REAL_PZSTUDIO = join(os.homedir(), '.pzstudio');
const REAL_PZSTUDIO_EXISTS_BEFORE = existsSync(REAL_PZSTUDIO);

const env = { ...process.env };
delete env.NODE_PATH;
env.HOME = ISOLATED_HOME;
env.USERPROFILE = ISOLATED_USERPROFILE;
env.HOMEDRIVE = ISOLATED_HOMEDRIVE;
env.HOMEPATH = ISOLATED_HOMEPATH;

console.log('=== Isolated environment ===');
console.log(`ISOLATED_HOME: ${ISOLATED_HOME}`);
console.log(`Real  HOME:   ${os.homedir()}`);

// ─── Project directory ───────────────────────────────────────────────────────

const TMP_PROJECT = tmpDir('project');
console.log(`\nTMP project: ${TMP_PROJECT}`);

// ─── Tests ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label, condition) {
    if (condition) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.error(`  ✗ FAIL: ${label}`);
        failed++;
    }
}

function section(name) {
    console.log(`\n── ${name} ──`);
}

// ─── 1. Install ─────────────────────────────────────────────────────────────

section('Install');

const installed = runOk(
    `npm install "${TGZ}" --omit=dev --prefix "${TMP_PROJECT}"`,
    { env, timeout: 300000 },
);
check('npm install succeeds', installed);

const INSTALLED_PKG = join(TMP_PROJECT, 'node_modules', '@pzstudio', 'cli');
check('tarball installed', existsSync(INSTALLED_PKG));

if (installed && existsSync(INSTALLED_PKG)) {
    const lsOut = run(
        `npm ls --omit=dev --prefix "${TMP_PROJECT}" --depth=0 --json`,
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lsJson = JSON.parse(lsOut.trim() || '{}');
    const topLevel = Object.keys(lsJson.dependencies || {});
    check(
        'npm ls --omit=dev is clean (no extraneous)',
        !topLevel.some((k) => lsJson.dependencies[k].extraneous),
    );
    check('top-level dep is @pzstudio/cli', topLevel.includes('@pzstudio/cli'));

    const installedPkgJson = JSON.parse(
        readFileSync(join(INSTALLED_PKG, 'package.json'), 'utf8'),
    );
    const sourcePkgJson = JSON.parse(
        readFileSync(join(SCRIPT_DIR, 'package.json'), 'utf8'),
    );
    check(
        'version matches the source package.json',
        installedPkgJson.version === sourcePkgJson.version,
    );
    check(
        'no workspace:* deps in installed package',
        !JSON.stringify(installedPkgJson.dependencies || {}).includes(
            'workspace:',
        ),
    );
    const installedDeps = Object.keys(installedPkgJson.dependencies || {});
    check(
        '@parcel/watcher is the only runtime dep',
        installedDeps.length === 1 && installedDeps[0] === '@parcel/watcher',
    );
    check(
        'installed package.json exposes only ./api (no main/types root)',
        !installedPkgJson.main && !installedPkgJson.types,
    );
    check(
        'LICENSE in the tarball matches the repo LICENSE.md byte-for-byte',
        readFileSync(join(INSTALLED_PKG, 'LICENSE')).equals(
            readFileSync(join(REPO_ROOT, 'LICENSE.md')),
        ),
    );
}

// ─── 2. Bin smoke ───────────────────────────────────────────────────────────

section('Bin smoke');

const CLI_BIN = join(INSTALLED_PKG, 'dist', 'index.js');
const CLI = `node "${CLI_BIN}"`;

check('dist/index.js exists', existsSync(CLI_BIN));

let versionOut = '';
check(
    'pzstudio --version succeeds',
    (() => {
        try {
            versionOut = run(`${CLI} --version`, { env });
            return versionOut.trim().length > 0;
        } catch {
            return false;
        }
    })(),
);
if (versionOut) console.log(`    version: ${versionOut.trim()}`);

check(
    'pzstudio --help succeeds',
    (() => {
        try {
            run(`${CLI} --help`, { env });
            return true;
        } catch {
            return false;
        }
    })(),
);

// Pure invocation leaves no ~/.pzstudio in the isolated home
check(
    'pure invocation leaves no ~/.pzstudio',
    !existsSync(join(ISOLATED_HOME, '.pzstudio')),
);

// ─── 3. Library (/api) smoke ────────────────────────────────────────────────

section('Library (/api) smoke');

const API_FILE = join(INSTALLED_PKG, 'dist', 'api.js');
check('dist/api.js exists', existsSync(API_FILE));

// require("@pzstudio/cli/api") must resolve through the exports map from
// the consuming project (spawned node with cwd = TMP_PROJECT).
const apiProbe = join(TMP_PROJECT, 'api-probe.cjs');
writeFileSync(
    apiProbe,
    [
        `const api = require('@pzstudio/cli/api');`,
        `const fns = ['runCLI', 'runProjectDoctor', 'createDevSync', 'planBuild'];`,
        `for (const f of fns) {`,
        `    if (typeof api[f] !== 'function') {`,
        `        console.error('missing or not a function: ' + f);`,
        `        process.exit(1);`,
        `    }`,
        `}`,
        `console.log('ok');`,
    ].join('\n'),
    'utf8',
);
check(
    'require("@pzstudio/cli/api") resolves and exports the API functions',
    (() => {
        try {
            const out = run(`node "${apiProbe}"`, { cwd: TMP_PROJECT, env });
            return out.trim() === 'ok';
        } catch (e) {
            console.error(
                `    Error: ${String(e.stderr || e.message).slice(0, 300)}`,
            );
            return false;
        }
    })(),
);

// Negative: requiring the package root must be rejected. There is no
// supported package-root library import — "." is not in the exports map.
const rootProbe = join(TMP_PROJECT, 'root-require.cjs');
writeFileSync(
    rootProbe,
    [
        `try {`,
        `    require('@pzstudio/cli');`,
        `    console.error('root require unexpectedly succeeded');`,
        `    process.exit(1);`,
        `} catch (e) {`,
        `    if (e && e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') process.exit(0);`,
        `    console.error('unexpected error: ' + (e && e.code));`,
        `    process.exit(1);`,
        `}`,
    ].join('\n'),
    'utf8',
);
check(
    'require("@pzstudio/cli") is rejected with ERR_PACKAGE_PATH_NOT_EXPORTED',
    (() => {
        try {
            run(`node "${rootProbe}"`, { cwd: TMP_PROJECT, env });
            return true;
        } catch (e) {
            console.error(
                `    Error: ${String(e.stderr || e.message).slice(0, 300)}`,
            );
            return false;
        }
    })(),
);

// ─── 4. Embedded artifact smoke ─────────────────────────────────────────────

section('Embedded artifact smoke');

// The /api bundle must create a real project with --offline, proving that
// __dirname-relative resources (.template-legacy, scripts) survive
// bundling on the embedder surface — the path the VS Code host uses.
const embeddedProbe = join(TMP_PROJECT, 'embedded-new.cjs');
writeFileSync(
    embeddedProbe,
    [
        `const { runCLI } = require(${JSON.stringify(API_FILE)});`,
        `runCLI('new', ['EmbeddedSmokeMod'], { flags: ['--offline'] })`,
        `    .then(() => process.exit(0))`,
        `    .catch((e) => {`,
        `        console.error(e && e.message ? e.message : String(e));`,
        `        process.exit(1);`,
        `    });`,
    ].join('\n'),
    'utf8',
);
check(
    'runCLI("new", --offline) from the api bundle creates a project',
    (() => {
        try {
            run(`node "${embeddedProbe}"`, {
                cwd: TMP_PROJECT,
                env,
                timeout: 120000,
            });
        } catch (e) {
            console.error(`    new failed: ${String(e.message).slice(0, 300)}`);
            return false;
        }
        return existsSync(
            join(TMP_PROJECT, 'EmbeddedSmokeMod', 'project.json'),
        );
    })(),
);

// The bin path (index.js bundle) proves the same for the executable surface.
check(
    'pzstudio new "BinSmokeMod" --offline creates a project (bin surface)',
    (() => {
        try {
            run(`${CLI} new "BinSmokeMod" --offline`, {
                cwd: TMP_PROJECT,
                env,
                timeout: 120000,
            });
        } catch (e) {
            console.error(`    new failed: ${String(e.message).slice(0, 300)}`);
            return false;
        }
        return existsSync(join(TMP_PROJECT, 'BinSmokeMod', 'project.json'));
    })(),
);

// ─── 5. Type consumer ────────────────────────────────────────────────────────

section('Type consumer (NodeNext TS)');

// A real isolated compile: a strict NodeNext consumer importing the four
// headline functions from @pzstudio/cli/api must typecheck cleanly with
// no dependencies other than the installed package (skipLibCheck off, so
// the vendored declarations are exercised too).
const consumerTs = join(TMP_PROJECT, 'consumer.ts');
writeFileSync(
    consumerTs,
    [
        `import { runCLI, runProjectDoctor, createDevSync, planBuild } from '@pzstudio/cli/api';`,
        ``,
        `const a: typeof runCLI = runCLI;`,
        `const b: typeof runProjectDoctor = runProjectDoctor;`,
        `const c: typeof createDevSync = createDevSync;`,
        `const d: typeof planBuild = planBuild;`,
        `void a; void b; void c; void d;`,
        ``,
    ].join('\n'),
    'utf8',
);
writeFileSync(
    join(TMP_PROJECT, 'tsconfig.json'),
    JSON.stringify(
        {
            compilerOptions: {
                target: 'esnext',
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                strict: true,
                noEmit: true,
                skipLibCheck: false,
            },
            files: ['consumer.ts'],
        },
        null,
        4,
    ),
    'utf8',
);
check(
    'isolated NodeNext strict consumer compiles (tsc --noEmit exit 0)',
    (() => {
        const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
        if (!existsSync(tsc)) {
            console.error(
                '    typescript not found in the repo — cannot run the consumer compile',
            );
            return false;
        }
        try {
            run(`node "${tsc}" -p "${TMP_PROJECT}"`, { env, timeout: 180000 });
            return true;
        } catch (e) {
            console.error(
                `    tsc failed:\n${String(e.stdout || e.message).slice(0, 2000)}`,
            );
            return false;
        }
    })(),
);

// ─── 6. Packlist assertions ─────────────────────────────────────────────────

section('Packlist assertions');

// Read the packlist straight from the exact tarball — no second npm pack.
// tar runs with cwd = the release dir and a relative filename: a drive-letter
// path like "D:/..." would be parsed as a remote host by GNU tar.
const tarOut = run(`tar -tzf "${TGZ.split(/[\\/]/).pop()}"`, {
    cwd: dirname(TGZ),
    stdio: ['pipe', 'pipe', 'pipe'],
});
const filePaths = new Set(
    tarOut
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) =>
            l.startsWith('package/') ? l.slice('package/'.length) : l,
        ),
);

const requiredFiles = [
    'package.json',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'dist/index.js',
    'dist/api.js',
    'dist/index.d.ts',
    'dist/api.d.ts',
    'dist/build.json',
    'dist/scripts/experimental-package-scripts.js',
];
for (const rf of requiredFiles) {
    check(`packlist contains ${rf}`, filePaths.has(rf));
}
const requiredPrefixes = [
    'dist/.template-legacy/',
    'dist/vendor/', // vendored declarations (REL-1C self-containment)
];
for (const rp of requiredPrefixes) {
    const found = [...filePaths].some((p) => p.startsWith(rp));
    check(`packlist contains ${rp}*`, found);
}

const forbiddenPatterns = [
    'src/',
    'tests/',
    'docs/',
    '.tmp/',
    'pnpm-lock.yaml',
    'dist/lib/*.js', // tsc intermediates must not ship (declarations only)
];
for (const fp of forbiddenPatterns) {
    const found = [...filePaths].some((p) =>
        fp.endsWith('*') ? p.startsWith(fp.slice(0, -1)) : p.startsWith(fp),
    );
    check(`packlist excludes ${fp}`, !found);
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

section('Cleanup');

try {
    rmSync(TMP_PROJECT, { recursive: true, force: true });
    rmSync(ISOLATED_HOME, { recursive: true, force: true });
    console.log('  temp dirs removed');
} catch (e) {
    console.error('  cleanup warning:', e.message);
}

check(
    'real ~/.pzstudio untouched by the smoke run',
    existsSync(REAL_PZSTUDIO) === REAL_PZSTUDIO_EXISTS_BEFORE,
);

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Smoke result: ${passed} passed, ${failed} failed`);
if (failed === 0) {
    console.log('All smoke checks passed. Artifact is releasable.');
    process.exit(0);
} else {
    console.error(`${failed} check(s) FAILED.`);
    process.exit(1);
}
