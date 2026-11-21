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

    const outcomes: OperationOutcome[] = [];
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

    let legacyFailed = false;
    let legacyState: 'refreshed' | 'up-to-date' | 'skipped' | 'failed';
    const legacyRoot = join(getConfigDir(), '.template-legacy');
    info('- Updating legacy fallback templates...');
    try {
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

    if (hasFlag('json')) {
        printJsonEnvelope('update', {
            categories: categoryResults,
            legacy: { state: legacyState, path: legacyRoot },
        });
    }

    const refreshed = outcomes.filter((o) => o.severity === 'success').length;
    const categoryFailure = aggregateOutcomeSeverity(outcomes) === 'failure';
    if (categoryFailure || legacyFailed) {
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
