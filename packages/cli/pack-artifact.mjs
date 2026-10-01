#!/usr/bin/env node
/**
 * pack-artifact.mjs — REL-2
 *
 * Packs the @pzstudio/cli artifact exactly once after a verified build.
 * Gate: no mutating prepare/prepack/postpack scripts may run; the tgz
 * filename is read from JSON, never constructed by hand.
 *
 * Usage: node pack-artifact.mjs <release-dir>
 *
 * <release-dir> must be an absolute path to an existing, empty directory.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';

const SCRIPT_DIR = dirname(process.argv[1]); // dir of pack-artifact.mjs = packages/cli/

const RELEASE_DIR = process.argv[2];

if (!RELEASE_DIR) {
    console.error('Usage: node pack-artifact.mjs <release-dir>');
    process.exit(1);
}

const absReleaseDir = resolve(RELEASE_DIR);

if (!existsSync(absReleaseDir)) {
    mkdirSync(absReleaseDir, { recursive: true });
    console.log(`Created release directory: ${absReleaseDir}`);
}

if (existsSync(absReleaseDir)) {
    const entries = (() => {
        try {
            return require('fs').readdirSync(absReleaseDir);
        } catch {
            return [];
        }
    })();
    if (entries.length > 0) {
        console.error(
            `Error: release directory ${absReleaseDir} is not empty (contains: ${entries.join(', ')}).`,
        );
        console.error('Use an empty directory or a subdirectory you control.');
        process.exit(1);
    }
}

const PKG_DIR = SCRIPT_DIR;
const PKG_JSON_PATH = join(PKG_DIR, 'package.json');

if (!existsSync(PKG_JSON_PATH)) {
    console.error(`Error: package.json not found at ${PKG_JSON_PATH}`);
    process.exit(1);
}

const distIndex = join(PKG_DIR, 'dist', 'index.js');
const distApi = join(PKG_DIR, 'dist', 'api.js');

if (!existsSync(distIndex)) {
    console.error(
        `Error: dist/index.js missing — run "pnpm --filter @pzstudio/cli build" first.`,
    );
    process.exit(1);
}
if (!existsSync(distApi)) {
    console.error(
        `Error: dist/api.js missing — run "pnpm --filter @pzstudio/cli build" first.`,
    );
    process.exit(1);
}

console.log(`Packing @pzstudio/cli from ${PKG_DIR}`);
console.log(`Destination: ${absReleaseDir}`);

const packJsonRaw = execSync(
    `npm pack --json --ignore-scripts --pack-destination "${absReleaseDir}"`,
    {
        cwd: PKG_DIR,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
    },
);

let packJson;
try {
    packJson = JSON.parse(packJsonRaw);
} catch {
    console.error('Failed to parse npm pack JSON output:');
    console.error(packJsonRaw);
    process.exit(1);
}

// npm pack --json returns an array with one entry per package
const entry = Array.isArray(packJson) ? packJson[0] : packJson;

if (!entry || !entry.filename) {
    console.error('Could not extract tarball filename from npm pack output:');
    console.error(JSON.stringify(packJson, null, 2));
    process.exit(1);
}

const tgzPath = join(absReleaseDir, entry.filename);

if (!existsSync(tgzPath)) {
    console.error(
        `Error: expected tarball not found at ${tgzPath} after npm pack succeeded.`,
    );
    console.exit(1);
}

console.log(`\nPack complete: ${tgzPath}`);
console.log(`Size: ${(entry.size / 1024).toFixed(1)} KB`);
console.log(`Shasum: ${entry.shasum}`);

// Persist resolved path for downstream smoke script
writeFileSync(
    join(absReleaseDir, '.tgz-path'),
    tgzPath,
    'utf8',
);

console.log(`\nTgz path persisted to ${join(absReleaseDir, '.tgz-path')}`);
console.log('Run: node pack-smoke.mjs "$(cat <release-dir>/.tgz-path)"');