import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { CliError } from '../errors';
import {
    OUTCOME_FAILURE,
    OUTCOME_SUCCESS,
    OperationOutcome,
    aggregateOutcomeSeverity,
} from '../outcome';
import { info, log, verbose, warn } from '../logger';
import { resolveTemplateDir, TemplateCategory } from '../templateManager';

addHelp(
    'update',
    `Update global template caches to the latest version.
    This command pulls the latest changes for all template categories (project, mod, workshop, language)
    and resets the local cache to match the remote source.

    Usages:
        pzstudio update - Refresh all global template caches from their remote sources.

    Flags:
        --verbose        - Enable diagnostic output.
        --transport <git|fetch> - Template download method (default: git when available, else fetch).`,
);

export async function updateCmd() {
    log(`\nRefreshing global template caches...`);

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
            log(`- Updating '${category}' templates...`);
            verbose(`Requesting template resolution for category: ${category}`);
            const path = resolveTemplateDir(category, false, true);
            verbose(`Templates for '${category}' updated at: ${path}`);
            outcomes.push(OUTCOME_SUCCESS);
        } catch (e: any) {
            warn(`Failed to update ${category} template: ${e.message}`);
            outcomes.push(OUTCOME_FAILURE);
        }
    }

    const refreshed = outcomes.filter((o) => o.severity === 'success').length;
    if (aggregateOutcomeSeverity(outcomes) === 'failure') {
        throw new CliError(
            `Refreshed ${refreshed}/${categories.length} template caches — ${categories.length - refreshed} update(s) failed. Fix the reported causes and run 'pzstudio update' again.`,
        );
    }
    info('\nAll template caches refreshed successfully!');
}

registerCommand({
    name: 'update',
    summary: 'Refresh the cached template repositories.',
    run: () => updateCmd(),
});
