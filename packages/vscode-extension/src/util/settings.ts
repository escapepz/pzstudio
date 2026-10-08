import * as vscode from 'vscode';
import type {
    PzStudioHostSettings,
    PzStudioSettingsContext,
} from '@pzstudio/cli/api';

/**
 * The one workspace/global inspect() snapshot the v2 provider consumes.
 * Identical layer shapes and workspaceValue/globalValue semantics as the
 * pre-migration push bridge (doc 11 §10, commit 7).
 */
function readLayerSnapshot(): PzStudioHostSettings {
    const config = vscode.workspace.getConfiguration('pzstudio');
    const outdirInspect = config.inspect<string>('outdir');
    const useSymlinksInspect = config.inspect<boolean>('useSymlinks');

    const extractTemplates = (valueKey: 'workspaceValue' | 'globalValue') => {
        const result: any = {};
        for (const cat of ['project', 'mod', 'workshop', 'language']) {
            const catConfig = vscode.workspace.getConfiguration(
                `pzstudio.templates.${cat}`,
            );
            const url = catConfig.inspect<string>('url')?.[valueKey];
            const ref = catConfig.inspect<string>('ref')?.[valueKey];
            if (url) {
                result[cat] = { url, ...(ref ? { ref } : {}) };
            }
        }
        return Object.keys(result).length > 0 ? result : undefined;
    };

    return {
        workspace: {
            templates: extractTemplates('workspaceValue'),
            outdir: outdirInspect?.workspaceValue,
            useSymlinks: useSymlinksInspect?.workspaceValue,
        },
        user: {
            templates: extractTemplates('globalValue'),
            outdir: outdirInspect?.globalValue,
            useSymlinks: useSymlinksInspect?.globalValue,
        },
    };
}

/**
 * Pure host settings reader for the v2 instance (doc 11 §10, commit 7):
 * the whole module's surface after the bridge retirement (commit 11).
 * Returns the same workspace/global snapshot, read fresh at each call;
 * the legacy push machinery (updateVsCodeSettings /
 * subscribeToConfigurationChanges → setVsCodeSettings) is gone — an
 * external consumer of the CLI's legacy facade feeds the slots directly.
 *
 * MVP: the context is accepted but INTENTIONALLY ignored — folder-scoped
 * multi-root settings are not resolved here yet, so UX-05 reproduces until
 * the later frozen commit switches this adapter to use the projectDir hint.
 */
export function readPzStudioHostSettings(
    _context: PzStudioSettingsContext,
): PzStudioHostSettings {
    return readLayerSnapshot();
}
