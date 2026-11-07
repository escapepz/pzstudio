import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { CliError } from '../errors';
import {
    OUTCOME_FAILURE,
    OUTCOME_SUCCESS,
    OperationOutcome,
    aggregateOutcomeSeverity,
} from '../outcome';
import { engineIo, info, verbose, warn } from '../logger';
import {
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

    Flags:
        --verbose        - Enable diagnostic output.
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
    for (const category of categories) {
        try {
            info(`- Updating '${category}' templates...`);
            verbose(`Requesting template resolution for category: ${category}`);
            const path = resolveTemplateDirForEngine(category, false, true);
            verbose(`Templates for '${category}' updated at: ${path}`);
            outcomes.push(OUTCOME_SUCCESS);
        } catch (e: any) {
            warn(`Failed to update ${category} template: ${e.message}`);
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
    info('- Updating legacy fallback templates...');
    try {
        refreshLegacyTemplates(engineIo());
    } catch (e: any) {
        warn(`Failed to refresh legacy templates: ${e.message}`);
        legacyFailed = true;
    }

    const refreshed = outcomes.filter((o) => o.severity === 'success').length;
    const categoryFailure = aggregateOutcomeSeverity(outcomes) === 'failure';
    if (categoryFailure || legacyFailed) {
        // Category failures keep the existing aggregate message; a
        // legacy-only failure gets its own actionable one.
        throw new CliError(
            categoryFailure
                ? `Refreshed ${refreshed}/${categories.length} template caches — ${categories.length - refreshed} update(s) failed. Fix the reported causes and run 'pzstudio update' again.`
                : `Refreshed ${refreshed}/${categories.length} template caches — the legacy template refresh failed. Fix the reported cause and run 'pzstudio update' again.`,
        );
    }
    info('\nAll template caches refreshed successfully!');
}

registerCommand({
    name: 'update',
    summary: 'Refresh the cached template repositories.',
    run: () => updateCmd(),
});
