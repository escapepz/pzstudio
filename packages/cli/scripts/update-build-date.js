const fs = require('fs');
const path = require('path');

const { copyDirRecursive } = require('./template-copy');

const packagePath = path.join(__dirname, '../package.json');
const distPath = path.join(__dirname, '../dist');
const buildPath = path.join(distPath, 'build.json');

// Ensure dist directory exists
if (!fs.existsSync(distPath)) {
    fs.mkdirSync(distPath, { recursive: true });
}

// Update buildDate to today's ISO date
const today = new Date().toISOString();
const buildInfo = {
    buildDate: today,
};

fs.writeFileSync(buildPath, JSON.stringify(buildInfo, null, 4) + '\n', 'utf8');
console.log(`Updated buildDate to ${today} in ${buildPath}`);

// Copy experimental-package-scripts.js to dist/scripts
const expScriptSource = path.join(__dirname, 'experimental-package-scripts.js');
const scriptsDistDir = path.join(distPath, 'scripts');
if (!fs.existsSync(scriptsDistDir)) {
    fs.mkdirSync(scriptsDistDir, { recursive: true });
}
const expScriptDest = path.join(
    scriptsDistDir,
    'experimental-package-scripts.js',
);
if (fs.existsSync(expScriptSource)) {
    fs.copyFileSync(expScriptSource, expScriptDest);
    console.log(`Copied experimental-package-scripts.js to ${expScriptDest}`);
}

// Remove dist/lib/*.js (intermediate tsc output — the bundled
// dist/index.js and dist/api.js replace everything that matters for
// runtime; only the .d.ts files are needed for TypeScript consumers).
// The .d.ts files and dist/lib/commands/*.d.ts are kept.
function removeJsFromLib(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            removeJsFromLib(fullPath);
        } else if (entry.name.endsWith('.js')) {
            fs.unlinkSync(fullPath);
        }
    }
}
removeJsFromLib(path.join(distPath, 'lib'));
console.log('Removed tsc intermediate .js files from dist/lib/');
const templateLegacyCandidates = [
    path.join(__dirname, '../../../.template-legacy'),
    path.join(__dirname, '../../.template-legacy'),
];
const templateLegacySource = templateLegacyCandidates.find(
    (candidate) =>
        fs.existsSync(candidate) &&
        fs.existsSync(path.join(candidate, '.template-project')),
);
const templateLegacyDest = path.join(distPath, '.template-legacy');

if (templateLegacySource) {
    // The submodule checkouts' .git gitfiles are runtime state and the
    // templates' .github/ CI workflows are repo metadata — never ship
    // either (tracked .gitignore and .gitmodules inside the templates
    // ARE content and stay).
    copyDirRecursive(templateLegacySource, templateLegacyDest, [
        '.git',
        '.github',
    ]);
    console.log(
        `Copied .template-legacy from ${templateLegacySource} to ${templateLegacyDest}`,
    );
    // Stamp the bundled copy so `pzstudio update` can tell whether the
    // installed global templates differ from the ones this build shipped.
    const version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
    // A missing version would produce an unreadable stamp and a silent
    // permanent skip of every future refresh — fail the build loudly.
    if (typeof version !== 'string') {
        throw new Error(
            'Cannot stamp legacy templates: packages/cli/package.json has no version',
        );
    }
    const stampPath = path.join(templateLegacyDest, '.pzstudio-templates.json');
    fs.writeFileSync(
        stampPath,
        JSON.stringify({ version, buildDate: today }, null, 4) + '\n',
        'utf8',
    );
    console.log(
        `Stamped legacy templates (${version}, ${today}) in ${stampPath}`,
    );
} else {
    console.warn(
        'No populated .template-legacy found (submodules not checked out?) — the built binary will not be able to bootstrap templates offline.',
    );
}
