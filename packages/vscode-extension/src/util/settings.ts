import * as vscode from 'vscode';
import { setVsCodeSettings } from '@pzstudio/cli/api';
import type {
    PzStudioHostSettings,
    PzStudioSettingsContext,
} from '@pzstudio/cli/api';

/**
 * The one workspace/global inspect() snapshot both tiers consume: the v2
 * provider returns it per run, the transitional compatibility bridge pushes
 * it into the legacy slots. Identical layer shapes and
 * workspaceValue/globalValue semantics as the pre-migration push bridge.
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
 * returns the same workspace/global snapshot, read fresh at each call.
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

/**
 * TRANSITIONAL COMPATIBILITY BRIDGE (doc 11 §17 commit 7, corrected):
 * pushes the same snapshot into the raw legacy settings slots. After the
 * consumer migrations (task provider commit 8, DevSync commit 9, doctor
 * and modinfo commit 10) no extension consumer reads these slots anymore
 * — every engine/operation path resolves through the v2 instance
 * provider. The push survives deliberately until the facade-setter
 * retirement (doc 11 §17 commit 11) and is never consumed by the v2 path.
 */
export function updateVsCodeSettings(): void {
    const layers = readLayerSnapshot();
    setVsCodeSettings(layers.workspace, layers.user);
}

/**
 * Re-pushes the snapshot whenever a pzstudio.* setting changes — the same
 * freshness the bridge had while legacy consumers still existed.
 */
export function subscribeToConfigurationChanges(): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('pzstudio')) {
            updateVsCodeSettings();
        }
    });
}
