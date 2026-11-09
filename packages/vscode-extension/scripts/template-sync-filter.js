const path = require('path');

const SKIP_NAMES = ['.git', '.github'];

/**
 * cpSync filter for syncing `.template-legacy/<template>` into the
 * extension package: drop the submodule checkout's .git gitfile and the
 * templates' .github/ CI workflows — repo metadata, never shipped content
 * (tracked .gitignore/.gitmodules are template content and survive).
 * Checks every path segment, so anything nested under a skipped
 * directory is rejected too, not just the top-level entry.
 */
function templateSyncFilter(src) {
    return !src.split(/[\\/]+/).some((segment) => SKIP_NAMES.includes(segment));
}

module.exports = { templateSyncFilter };
