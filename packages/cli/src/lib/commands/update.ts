import { join } from 'path';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { CliError } from '../errors';
import { hasFlag } from '../args';
import { printJsonEnvelope } from '../json';
import {
    OUTCOME_FAILURE,
    OUTCOME_SUCCESS,
    OperationOutcome,
    aggregateOutcomeSeverity,
} from '../outcome';
import { engineIo, info, verbose, warn } from '../logger';
import {
    getConfigDir,
    refreshLegacyTemplates,
    resolveTemplateDirForEngine,
    TemplateCategory,
} from '../templateManager';

addHelp(
    'update',
    `Update global template caches to the latest version.
    This command pulls the latest changes for all template categories (project, mod, workshop, language)
    and resets the local cache to match the remote source.
    Bundled legacy fallback templates are refreshed into the global config dir when they differ from the installed copy.

    Usages:
        pzstudio update - Refresh all global template caches from their remote sources.
        pzstudio update --json - Print a machine-readable envelope instead.

    Flags:
        --verbose        - Enable diagnostic output.
        --json           - Print the v1 JSON envelope (schemaVersion/command/result) with the per-category end states.
        --transport <git|fetch> - Template download method (default: git when available, else fetch).`,
);

export async function updateCmd() {
    info(`\nRefreshing global template caches...`);

    const categories: TemplateCategory[] = [
        'project',
        'mod',
        'workshop',
        'language',
    ];

    // Per-category isolation: every category is attempted even when earlier
    // ones failed; the aggregate severity decides the exit code (CLI-6).
    const outcomes: OperationOutcome[] = [];
    // The end state per category is also the machine result (d11-F1): the
    // cache dir the update answered with, the bundled legacy copy it fell
    // back to, or a failure.
    const categoryResults: Array<{
        category: TemplateCategory;
        state: 'updated' | 'legacy-fallback' | 'failed';
        path?: string;
    }> = [];
    for (const category of categories) {
        try {
            info(`- Updating '${category}' templates...`);
            verbose(`Requesting template resolution for category: ${category}`);
            const path = resolveTemplateDirForEngine(category, false, true);
            // The resolved path IS the directory the update left in place:
            // the category's cache when the cache answered, the bundled
            // legacy copy otherwise (d15-F2 — name the dir + the end state).
            const legacyDir = join(
                getConfigDir(),
                '.template-legacy',
                `.template-${category}`,
            );
            const state = path === legacyDir ? 'legacy-fallback' : 'updated';
            info(
                `- '${category}' templates ${
                    state === 'legacy-fallback'
                        ? 'fell back to legacy'
                        : 'updated'
                } at: ${path}`,
            );
            verbose(`Templates for '${category}' updated at: ${path}`);
            categoryResults.push({ category, state, path });
            outcomes.push(OUTCOME_SUCCESS);
        } catch (e: any) {
            warn(`Failed to update ${category} template: ${e.message}`);
            categoryResults.push({ category, state: 'failed' });
            outcomes.push(OUTCOME_FAILURE);
        }
    }

    // Same isolation for the bundled legacy fallback cache (CLI-6): the
    // refresh owns its own lines for every status ('refreshed',
    // 'up-to-date', 'skipped'); a failure warns here and flips the exit
    // code below without masking the per-category messages. The engine
    // scope keeps those helper emissions on their §12 ambient routing —
    // the invocation logger under studio.run, raw legacy (byte-identical)
    // for the standalone CLI.
    let legacyFailed = false;
    let legacyState: 'refreshed' | 'up-to-date' | 'skipped' | 'failed';
    const legacyRoot = join(getConfigDir(), '.template-legacy');
    info('- Updating legacy fallback templates...');
    try {
        // The refresh owns its own status line; this one names the global
        // dir and the END state the returned status describes (d15-F2).
        const status = refreshLegacyTemplates(engineIo());
        legacyState = status;
        if (status === 'refreshed') {
            info(`- Legacy fallback templates refreshed at: ${legacyRoot}`);
        } else if (status === 'up-to-date') {
            info(
                `- Legacy fallback templates already up to date at: ${legacyRoot}`,
            );
        } else {
            info(
                `- Legacy fallback templates skipped; global copy left at: ${legacyRoot}`,
            );
        }
    } catch (e: any) {
        warn(`Failed to refresh legacy templates: ${e.message}`);
        legacyFailed = true;
        legacyState = 'failed';
    }

    // Machine output (CLI-8, d11-F1): the envelope is the ONLY stdout
    // content (every human line here is stderr). The per-category end
    // states are the machine-relevant result; a partially failed run
    // still prints the envelope before the aggregate error — exit code
    // follows the result, exactly like doctor/logs --json.
    if (hasFlag('json')) {
        printJsonEnvelope('update', {
            categories: categoryResults,
            legacy: { state: legacyState, path: legacyRoot },
        });
    }

    const refreshed = outcomes.filter((o) => o.severity === 'success').length;
    const categoryFailure = aggregateOutcomeSeverity(outcomes) === 'failure';
    if (categoryFailure || legacyFailed) {
        // Category failures keep the existing aggregate message; a
        // legacy-only failure gets its own actionable one.
        throw new CliError(
            categoryFailure
                ? `Refreshed ${refreshed}/${categories.length} template caches — ${categories.length - refreshed} update(s) failed. Fix the reported causes and run 'pzstudio update' again.`
                : `All ${categories.length} template caches refreshed — the legacy template refresh failed. Fix the reported cause and run 'pzstudio update' again.`,
        );
    }
    info(
        `\nAll template caches refreshed successfully! Template caches live under ${join(getConfigDir(), 'templates')}; the bundled legacy fallback lives in ${join(getConfigDir(), '.template-legacy')}.`,
    );
}

registerCommand({
    name: 'update',
    summary: 'Refresh the cached template repositories.',
    flags: [{ name: 'json' }],
    run: () => updateCmd(),
});
