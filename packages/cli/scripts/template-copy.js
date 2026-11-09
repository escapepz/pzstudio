const fs = require('fs');
const path = require('path');

/**
 * Recursively copy the template tree at `src` into `dest`, skipping any
 * entry (file or directory) whose name appears in `skipNames`.
 *
 * Build scripts pass ['.git', '.github']: the submodule checkouts' .git
 * gitfiles are runtime state and the templates' .github/ CI workflows are
 * repo metadata — neither is template content. Tracked .gitignore and
 * .gitmodules inside the templates ARE content and ship.
 */
function copyDirRecursive(src, dest, skipNames) {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        if (skipNames.includes(entry.name)) continue;
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath, skipNames);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

module.exports = { copyDirRecursive };
