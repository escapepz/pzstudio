'use strict';

/**
 * Template pinning script for .template-legacy: config + git ref resolution
 * (config: scripts/template-pin.json), pin diff vs HEAD, gitlink staging
 * and the CLI entry (--check / apply).
 *
 * CommonJS on purpose: loaded directly by tests without a build step.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'template-pin.json');
const VALID_MODES = ['tag', 'branch'];

// Numeric release tags only: 42, 42.13, 42.13.1, with an optional suffix
// after the first hyphen (e.g. 42.22.0-20261109-1902). Applied to the
// ref's basename.
const TAG_RE = /^(\d+(?:\.\d+){0,2})(?:-([0-9A-Za-z.-]+))?$/;

/**
 * @typedef {Object} PinConfig
 * @property {string} name
 * @property {string} url
 * @property {'tag' | 'branch'} mode
 */

/**
 * @typedef {Object} LsRemoteEntry
 * @property {string} ref
 * @property {string} sha
 * @property {string} [peeledSha] commit sha of an annotated tag
 */

/**
 * Load and validate the template pin config.
 * @param {string} [configPath] defaults to scripts/template-pin.json
 * @returns {PinConfig[]}
 */
function loadConfig(configPath) {
    const file = configPath || DEFAULT_CONFIG_PATH;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) {
        throw new Error(`template pin config must be an array: ${file}`);
    }
    return raw.map((entry) => {
        if (!entry || typeof entry.name !== 'string' || entry.name === '') {
            throw new Error(`template pin entry missing "name": ${file}`);
        }
        if (typeof entry.url !== 'string' || entry.url === '') {
            throw new Error(`template pin entry "${entry.name}" missing "url"`);
        }
        if (!VALID_MODES.includes(entry.mode)) {
            throw new Error(
                `template pin entry "${entry.name}" has invalid mode ${JSON.stringify(entry.mode)} (expected "tag" or "branch")`,
            );
        }
        return { name: entry.name, url: entry.url, mode: entry.mode };
    });
}

/**
 * Parse `git ls-remote` output ("<sha>\t<ref>" lines). A line whose ref
 * ends in "^{}" is the peeled commit of an annotated tag; it is attached
 * as `peeledSha` on the entry for the stripped base ref instead of
 * becoming an entry of its own. Malformed lines (no separator, empty
 * sha or ref) are ignored.
 * @param {string} stdout
 * @returns {LsRemoteEntry[]}
 */
function parseLsRemoteTags(stdout) {
    const peeled = [];
    const byRef = new Map();
    const entries = [];
    for (const line of stdout.split(/\r?\n/)) {
        const sep = line.indexOf('\t');
        if (sep <= 0) continue;
        const sha = line.slice(0, sep).trim();
        const ref = line.slice(sep + 1).trim();
        if (sha === '' || ref === '') continue;
        if (ref.endsWith('^{}')) {
            peeled.push({ sha, baseRef: ref.slice(0, -3) });
            continue;
        }
        const entry = { ref, sha };
        entries.push(entry);
        byRef.set(ref, entry);
    }
    for (const { sha, baseRef } of peeled) {
        const base = byRef.get(baseRef);
        if (base) base.peeledSha = sha;
    }
    return entries;
}

/**
 * Split a parsed tag version into numeric parts (missing parts are 0).
 */
function versionParts(version) {
    const parts = version.split('.');
    return {
        major: Number(parts[0]) || 0,
        minor: Number(parts[1]) || 0,
        patch: Number(parts[2]) || 0,
    };
}

/**
 * Order two parsed tags: version numerically first, then plain releases
 * over suffixed ones, then suffixes lexicographically.
 */
function compareTags(a, b) {
    const va = versionParts(a.version);
    const vb = versionParts(b.version);
    if (va.major !== vb.major) return va.major - vb.major;
    if (va.minor !== vb.minor) return va.minor - vb.minor;
    if (va.patch !== vb.patch) return va.patch - vb.patch;
    const aPlain = a.suffix === undefined;
    const bPlain = b.suffix === undefined;
    if (aPlain !== bPlain) return aPlain ? 1 : -1;
    if (!aPlain && a.suffix !== b.suffix) {
        return a.suffix < b.suffix ? -1 : 1;
    }
    return 0;
}

/**
 * Resolve a pin to the commit sha to pin against.
 * @param {LsRemoteEntry[]} entries parsed `git ls-remote` output
 * @param {'tag' | 'branch'} mode
 * @returns {{ sha: string; source: string } | undefined}
 */
function resolvePin(entries, mode) {
    if (mode === 'branch') {
        const head = entries.find((e) => e.ref === 'HEAD');
        if (head) return { sha: head.sha, source: 'HEAD' };
        const branch = entries.find((e) => e.ref.startsWith('refs/heads/'));
        if (branch) return { sha: branch.sha, source: branch.ref };
        return undefined;
    }
    let best;
    for (const entry of entries) {
        const base = entry.ref.slice(entry.ref.lastIndexOf('/') + 1);
        const match = TAG_RE.exec(base);
        if (!match) continue;
        const candidate = { version: match[1], suffix: match[2], entry };
        if (!best || compareTags(candidate, best) > 0) best = candidate;
    }
    if (!best) return undefined;
    return {
        sha: best.entry.peeledSha ?? best.entry.sha,
        source: best.entry.ref,
    };
}

/**
 * Runs a git command and returns its result.
 * @typedef {(args: string[], opts?: { cwd?: string; input?: string }) =>
 *     { status: number; stdout: string; stderr: string }} GitRunner
 */

/**
 * A pending pin change: the gitlink `name` moves from the currently pinned
 * `from` sha (undefined when the template is not in the index yet) to `to`,
 * resolved from `source`.
 * @typedef {Object} Update
 * @property {string} name
 * @property {string | undefined} from
 * @property {string} to
 * @property {string} source
 */

/**
 * Read the gitlink shas currently pinned under .template-legacy/ in HEAD's
 * tree (`git ls-tree HEAD .template-legacy/`). Only `160000 commit` entries
 * are kept, keyed by their name below .template-legacy/.
 * @param {GitRunner} runner
 * @returns {Map<string, string>} gitlink name -> pinned sha
 */
function readCurrentPins(runner) {
    const res = runner(['ls-tree', 'HEAD', '.template-legacy/']);
    if (res.status !== 0) {
        throw new Error(
            `git ls-tree HEAD .template-legacy/ failed (${res.status}): ${res.stderr.trim()}`,
        );
    }
    const pins = new Map();
    for (const line of res.stdout.split(/\r?\n/)) {
        const sep = line.indexOf('\t');
        if (sep <= 0) continue;
        const meta = line.slice(0, sep).trim().split(/\s+/);
        const filePath = line.slice(sep + 1).trim();
        const [mode, kind, sha] = meta;
        if (mode !== '160000' || kind !== 'commit' || !sha) continue;
        const prefix = '.template-legacy/';
        if (!filePath.startsWith(prefix)) continue;
        const name = filePath.slice(prefix.length);
        if (name !== '') pins.set(name, sha);
    }
    return pins;
}

/**
 * Compare every config entry's newest remote ref against the currently
 * pinned sha. Repos whose pin cannot be resolved (e.g. no numeric tag) are
 * skipped; otherwise an update is emitted whenever the remote sha differs
 * from the pinned one (including templates not pinned at all yet).
 * @param {GitRunner} runner
 * @param {PinConfig[]} config
 * @returns {Update[]}
 */
function computeUpdates(runner, config) {
    const current = readCurrentPins(runner);
    const updates = [];
    for (const entry of config) {
        const res = runner(['ls-remote', entry.url]);
        if (res.status !== 0) {
            throw new Error(
                `git ls-remote ${entry.url} failed (${res.status}): ${res.stderr.trim()}`,
            );
        }
        const resolved = resolvePin(parseLsRemoteTags(res.stdout), entry.mode);
        if (!resolved) continue;
        if (current.get(entry.name) === resolved.sha) continue;
        updates.push({
            name: entry.name,
            from: current.get(entry.name),
            to: resolved.sha,
            source: resolved.source,
        });
    }
    return updates;
}

/**
 * Stage the new gitlink shas in the index (`git update-index --cacheinfo`).
 * Index-only staging keeps the worktree untouched; the resulting commit
 * updates the tree without a dirty status.
 * @param {GitRunner} runner
 * @param {Update[]} updates
 * @returns {number} number of gitlinks staged
 */
function applyUpdates(runner, updates) {
    let applied = 0;
    for (const update of updates) {
        const res = runner([
            'update-index',
            '--cacheinfo',
            `160000,${update.to},.template-legacy/${update.name}`,
        ]);
        if (res.status !== 0) {
            throw new Error(
                `git update-index .template-legacy/${update.name} failed (${res.status}): ${res.stderr.trim()}`,
            );
        }
        applied++;
    }
    return applied;
}

const USAGE = [
    'Usage: node scripts/pin-template-legacy.js [--check]',
    '',
    '  --check   print pending pin updates; exit 1 when any exist, 0 otherwise',
    '  (default) apply pending pin updates via git update-index and print a summary',
].join('\n');

/**
 * CLI entry: `--check` reports pending updates (exit 1 when any exist);
 * the default mode applies them and prints a summary.
 * @param {string[]} argv command-line arguments (no node/script prefix)
 * @param {GitRunner} [runner] git runner; defaults to spawning real git
 * @returns {number} process exit code
 */
function main(argv, runner = defaultRunner) {
    let check = false;
    for (const arg of argv) {
        if (arg === '--check') {
            check = true;
        } else {
            console.log(USAGE);
            return 2;
        }
    }
    const config = loadConfig();
    if (check) {
        const updates = computeUpdates(runner, config);
        for (const update of updates) {
            console.log(
                `- ${update.name}: ${update.from ?? '(none)'} → ${update.to} (${update.source})`,
            );
        }
        return updates.length ? 1 : 0;
    }
    const applied = applyUpdates(runner, computeUpdates(runner, config));
    console.log(`Pinned ${applied} template(s)`);
    return 0;
}

/**
 * Real GitRunner: spawns `git` with piped stdout/stderr. `opts` is forwarded
 * to spawnSync (e.g. cwd, input).
 * @param {string[]} args
 * @param {{ cwd?: string; input?: string }} [opts]
 * @returns {{ status: number; stdout: string; stderr: string }}
 */
function defaultRunner(args, opts) {
    const res = spawnSync('git', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 120_000,
        ...opts,
    });
    return {
        status: res.status ?? -1,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
    };
}

module.exports = {
    loadConfig,
    parseLsRemoteTags,
    resolvePin,
    readCurrentPins,
    computeUpdates,
    applyUpdates,
    main,
    defaultRunner,
};

if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}
