#!/usr/bin/env node
/**
 * pack-golden.mjs — REL-3
 *
 * Golden-path smoke against the exact packed tarball. Three NON-REUSED
 * isolated HOMEs (no cache contamination between scenarios):
 *
 *   HOME_A offline: new "Offline Smoke" --offline → doctor (exit 0)
 *   HOME_B online:  new "Smoke Mod" → doctor → build (template clone,
 *                   explicit hard timeout)
 *   HOME_C POSIX:   watch → banner → touch source → sync summary →
 *                   SIGINT → exit 130 with exactly one
 *                   "Development sync stopped."
 *
 * HOME_C is skipped on win32: SIGINT delivery to child processes is not
 * reliable there (same convention as the bin-watch real-env suite — CI
 * ubuntu/macos verify it). Every scenario runs with hard timeouts and the
 * script always terminates the child process trees it spawned, so CI can
 * never hang on it.
 *
 * Usage: node pack-golden.mjs <exact-tgz>
 */

import { execSync, spawn } from 'child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import { tmpdir } from 'os';

const TGZ = process.argv[2];
if (!TGZ || !existsSync(TGZ)) {
    console.error('Usage: node pack-golden.mjs <exact-tgz>');
    process.exit(1);
}

const IS_POSIX = process.platform !== 'win32';

// ─── Isolated environment helpers ───────────────────────────────────────────

function tmpRoot(label) {
    return mkdtempSync(join(tmpdir(), `pzstudio-golden-${label}-`));
}

function isolatedEnv(home) {
    const env = { ...process.env };
    delete env.NODE_PATH;
    env.HOME = home;
    env.USERPROFILE = home;
    env.HOMEDRIVE = home.slice(0, 2);
    env.HOMEPATH = home.slice(2);
    return env;
}

// Mirrors the CLI's getCachePathFromUrl + DEFAULT_TEMPLATES.workshop.url —
// keep in sync with packages/core/src/constants.ts and tests/helpers/real-env.ts.
function workshopCachePath(home) {
    const url = 'https://github.com/escapepz/pzstudio-template-workshop.git';
    const [user, repo] = url
        .replace('https://github.com/', '')
        .replace('.git', '')
        .split('/');
    return join(home, '.pzstudio', 'templates', user, repo);
}

function seedWorkshopTemplateCache(home, installedPkg) {
    const legacyWorkshop = join(
        installedPkg,
        'dist',
        '.template-legacy',
        '.template-workshop',
    );
    if (
        !existsSync(legacyWorkshop) ||
        readdirSync(legacyWorkshop).length === 0
    ) {
        throw new Error(
            'installed dist/.template-legacy/.template-workshop is empty — the tarball was built without template submodules',
        );
    }
    const cache = workshopCachePath(home);
    cpSync(legacyWorkshop, cache, { recursive: true });
    // The copied snapshot carries the submodule's .git gitlink file; replace
    // it with a real .git directory so the cache probe accepts it.
    rmSync(join(cache, '.git'), { force: true, recursive: true });
    mkdirSync(join(cache, '.git'), { recursive: true });
}

// ─── Scenario state / reporting ─────────────────────────────────────────────

const tmpRoots = [];
const children = new Set();

let passed = 0;
let failed = 0;
let skipped = 0;

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

function cleanup() {
    for (const child of children) {
        try {
            if (child.exitCode === null && child.signalCode === null) {
                // Negative pid kills the whole detached process group.
                if (IS_POSIX) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            }
        } catch {
            // already gone
        }
    }
    children.clear();
    for (const root of tmpRoots) {
        try {
            rmSync(root, { recursive: true, force: true });
        } catch (e) {
            console.error(`  cleanup warning for ${root}: ${e.message}`);
        }
    }
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

function runCli(bin, args, { cwd, env, timeout }) {
    try {
        const stdout = execSync(`node "${bin}" ${args.join(' ')}`, {
            cwd,
            env,
            timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf8',
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        const err = new Error(`command failed: pzstudio ${args.join(' ')}`);
        err.code = e.status;
        err.stdout = e.stdout || '';
        err.stderr = e.stderr || '';
        err.killed = e.killed;
        throw err;
    }
}

function reportFailure(e) {
    console.error(
        `    (got ${e.code}${e.killed ? ', TIMEOUT' : ''}) stdout: ${String(e.stdout).slice(-500)}`,
    );
    console.error(`    stderr: ${String(e.stderr).slice(-500)}`);
}

// ─── Install the exact tarball once ─────────────────────────────────────────

section('Install (once, shared by all scenarios)');
console.log(`  tgz: ${basename(TGZ)}`);

const INSTALL_ROOT = tmpRoot('install');
tmpRoots.push(INSTALL_ROOT);
const INSTALL_ENV = isolatedEnv(join(INSTALL_ROOT, 'home'));
mkdirSync(INSTALL_ENV.HOME, { recursive: true });

execSync(`npm install "${TGZ}" --omit=dev --prefix "${INSTALL_ROOT}"`, {
    env: INSTALL_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 300000,
});
const INSTALLED_BIN = join(
    INSTALL_ROOT,
    'node_modules',
    '@pzstudio',
    'cli',
    'dist',
    'index.js',
);
const INSTALLED_PKG = dirname(dirname(INSTALLED_BIN));
if (!existsSync(INSTALLED_BIN)) {
    console.error(
        '  ✗ FAIL: installed dist/index.js not found — cannot run golden smoke',
    );
    process.exit(1);
}
console.log('  ✓ tarball installed');
passed++;

// ─── HOME_A — offline golden path ───────────────────────────────────────────

section('HOME_A — offline: new --offline → doctor');

{
    const homeRoot = tmpRoot('homeA');
    const projBase = tmpRoot('projA');
    tmpRoots.push(homeRoot, projBase);
    const home = join(homeRoot, 'home');
    const projRoot = join(projBase, 'ws');
    const envA = isolatedEnv(home);
    mkdirSync(home, { recursive: true });
    mkdirSync(projRoot, { recursive: true });

    let ok = true;
    try {
        runCli(INSTALLED_BIN, ['new "Offline Smoke"', '--offline'], {
            cwd: projRoot,
            env: envA,
            timeout: 120000,
        });
        check('new --offline exits 0', true);
    } catch (e) {
        ok = false;
        check('new --offline exits 0', false);
        reportFailure(e);
    }

    // `new` derives the project folder from the title-to-id conversion
    // ("Offline Smoke" → offline_smoke), not the raw title.
    const projectDir = join(projRoot, 'offline_smoke');
    check('project.json exists', existsSync(join(projectDir, 'project.json')));

    if (ok && existsSync(projectDir)) {
        try {
            const doc = runCli(INSTALLED_BIN, ['doctor'], {
                cwd: projectDir,
                env: envA,
                timeout: 120000,
            });
            check('doctor exits 0 on a fresh project', doc.code === 0);
        } catch (e) {
            check('doctor exits 0 on a fresh project', false);
            reportFailure(e);
        }
    }
}

// ─── HOME_B — online golden path ────────────────────────────────────────────

section('HOME_B — online: new → doctor → build (template clone)');

{
    const homeRoot = tmpRoot('homeB');
    const projBase = tmpRoot('projB');
    tmpRoots.push(homeRoot, projBase);
    const home = join(homeRoot, 'home');
    const projRoot = join(projBase, 'ws');
    const envB = isolatedEnv(home);
    mkdirSync(home, { recursive: true });
    mkdirSync(projRoot, { recursive: true });

    let projectDir = null;
    try {
        runCli(INSTALLED_BIN, ['new "Smoke Mod"'], {
            cwd: projRoot,
            env: envB,
            timeout: 300000,
        });
        check('new exits 0', true);
        projectDir = join(projRoot, 'smoke_mod');
    } catch (e) {
        check('new exits 0', false);
        reportFailure(e);
    }

    if (projectDir && existsSync(projectDir)) {
        try {
            runCli(INSTALLED_BIN, ['doctor'], {
                cwd: projectDir,
                env: envB,
                timeout: 120000,
            });
            check('doctor exits 0', true);
        } catch (e) {
            check('doctor exits 0', false);
            reportFailure(e);
        }

        // Build resolves the workshop template: not cached in HOME_B, so
        // this exercises the real network path (git clone or zip fetch).
        try {
            runCli(INSTALLED_BIN, ['build'], {
                cwd: projectDir,
                env: envB,
                timeout: 600000,
            });
            check('build exits 0 (online template resolution)', true);
        } catch (e) {
            check('build exits 0 (online template resolution)', false);
            reportFailure(e);
        }
    }
}

// ─── HOME_C — POSIX watch ───────────────────────────────────────────────────

section('HOME_C — POSIX: watch → edit → sync summary → SIGINT → 130');

if (!IS_POSIX) {
    console.log(
        '  SKIP: POSIX-only (win32 cannot deliver SIGINT reliably); CI ubuntu/macos verify it.',
    );
    skipped++;
} else {
    const homeRoot = tmpRoot('homeC');
    const projBase = tmpRoot('projC');
    tmpRoots.push(homeRoot, projBase);
    const home = join(homeRoot, 'home');
    const projRoot = join(projBase, 'ws');
    const envC = isolatedEnv(home);
    mkdirSync(home, { recursive: true });
    mkdirSync(projRoot, { recursive: true });

    // Seed the workshop template cache from the installed bundle so the
    // watch startup full build is hermetic (no network).
    seedWorkshopTemplateCache(home, INSTALLED_PKG);

    const projectDir = join(projRoot, 'watch_smoke');
    try {
        runCli(INSTALLED_BIN, ['new "Watch Smoke"', '--offline'], {
            cwd: projRoot,
            env: envC,
            timeout: 120000,
        });
    } catch (e) {
        check('setup: new --offline exits 0', false);
        reportFailure(e);
    }

    if (existsSync(projectDir)) {
        // watch runs until we SIGINT it — spawn (not execSync) with its own
        // process group so the tree can always be killed.
        const child = spawn(process.execPath, [INSTALLED_BIN, 'watch'], {
            cwd: projectDir,
            env: envC,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        });
        children.add(child);

        let output = '';
        child.stdout.on('data', (c) => {
            output += c.toString();
        });
        child.stderr.on('data', (c) => {
            output += c.toString();
        });

        const bannerSeen = (text) =>
            text.includes("Syncing 'Watch Smoke'") &&
            text.includes('press Ctrl+C to stop');
        const summarySeen = (text) => text.includes('file(s) synced');

        const waitFor = (predicate, timeoutMs) =>
            new Promise((resolveWait) => {
                const started = Date.now();
                const timer = setInterval(() => {
                    if (predicate(output) || child.exitCode !== null) {
                        clearInterval(timer);
                        resolveWait(true);
                    } else if (Date.now() - started > timeoutMs) {
                        clearInterval(timer);
                        resolveWait(false);
                    }
                }, 250);
            });

        const bannerOk = await waitFor(bannerSeen, 90000);
        check('watch prints the sync banner', bannerOk);

        if (bannerOk && child.exitCode === null) {
            // The banner prints BEFORE session.start() runs the initial
            // full build. Wait for both workshop outputs to materialize
            // first — a probe written during the initial build is absorbed
            // into its snapshot and never produces an incremental batch.
            const mainModsDir = join(
                home,
                'Zomboid',
                'Workshop',
                'Watch Smoke',
                'Contents',
                'mods',
                'watch_smoke',
            );
            const devModsDir = join(
                home,
                'Zomboid',
                'Workshop',
                'Watch Smoke - dev_branch',
                'Contents',
                'mods',
                'watch_smoke_dev',
            );
            const settled = await waitFor(
                () => existsSync(mainModsDir) && existsSync(devModsDir),
                120000,
            );
            check('watch initial full build settled', settled);

            if (settled && child.exitCode === null) {
                // The watcher subscribes AFTER session.start() prints
                // "Watching for changes...", so a probe written between the
                // settled outputs and the subscription attach is silently
                // absorbed (the bin-streams real-env suite caught exactly
                // this race on fast CI runners). Wait for the ready line,
                // then touch the probe with fresh content until a coalesced
                // batch syncs — whichever touch lands after attach wins.
                const readyOk = await waitFor(
                    () => output.includes('Watching for changes'),
                    90000,
                );
                check('watch session reports ready', readyOk);

                // The probe goes into the existing 42/ branch folder —
                // mod-root files do not sync when branch folders exist
                // (docs/cli/07). Mod folders live at the project root (the
                // id is a project.json `mods` key, not a `mods/` directory).
                const project = JSON.parse(
                    readFileSync(join(projectDir, 'project.json'), 'utf8'),
                );
                const modKey = Object.keys(project.mods ?? {})[0];
                if (!modKey) {
                    throw new Error(
                        'project.json lists no mods — cannot place the watch probe',
                    );
                }
                const luaDir = join(
                    projectDir,
                    modKey,
                    '42',
                    'media',
                    'lua',
                    'shared',
                );
                mkdirSync(luaDir, { recursive: true });
                const probePath = join(luaDir, 'golden_probe.lua');

                let summaryOk = false;
                for (
                    let touch = 0;
                    touch < 30 && !summaryOk && child.exitCode === null;
                    touch++
                ) {
                    writeFileSync(
                        probePath,
                        `function GoldenProbe() end // touch ${touch}\n`,
                        'utf8',
                    );
                    summaryOk = await waitFor(summarySeen, 3000);
                }
                check('watch reports a synced batch', summaryOk);
            }
        }
        if (!bannerOk) {
            console.error(`    output so far: ${output.slice(-600)}`);
        }

        // SIGINT the whole process group; watch owns the signal and must
        // exit 130 with exactly one stop message.
        let exitInfo = { code: null, signal: null };
        child.once('exit', (code, signal) => {
            exitInfo = { code, signal };
        });
        try {
            process.kill(-child.pid, 'SIGINT');
        } catch (e) {
            console.error(`    SIGINT failed: ${e.message}`);
        }

        const exited = await waitFor(
            () => exitInfo.code !== null || exitInfo.signal !== null,
            30000,
        );
        check('watch exits after SIGINT', exited);
        if (!exited) {
            console.error(`    output so far: ${output.slice(-600)}`);
        }
        check(
            `watch exit code is 130 (got code=${exitInfo.code} signal=${exitInfo.signal})`,
            exitInfo.code === 130,
        );
        const stopMessages =
            output.split('Development sync stopped.').length - 1;
        check(
            `exactly one "Development sync stopped." message (got ${stopMessages})`,
            stopMessages === 1,
        );

        children.delete(child); // exited on its own; cleanup() skips it
    }
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
const skippedNote =
    skipped > 0 ? `, ${skipped} skipped (POSIX-only on this host)` : '';
console.log(`Golden result: ${passed} passed, ${failed} failed${skippedNote}`);
if (failed === 0) {
    console.log('Golden path is releasable.');
    process.exit(0);
} else {
    console.error(`${failed} check(s) FAILED.`);
    process.exit(1);
}
