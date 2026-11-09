'use strict';

/**
 * Template pin config + git ref resolution core for the .template-legacy
 * pinning script (config: scripts/template-pin.json).
 *
 * CommonJS on purpose: loaded directly by tests and the later pin/apply
 * tasks without a build step.
 */

const fs = require('fs');
const path = require('path');

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

module.exports = {
    loadConfig,
    parseLsRemoteTags,
    resolvePin,
};
