import * as vscode from 'vscode';
import type {
    PzStudioHostSettings,
    PzStudioSettingsContext,
} from '@pzstudio/cli/api';

/**
 * Defined-value folder/workspace precedence (never truthiness): a
 * folder-scoped value — including `false`, `''` or `0` — replaces the
 * workspace value; only its absence falls through to it.
 */
function composeWorkspace<T>(
    folderValue: T | undefined,
    workspaceValue: T | undefined,
): T | undefined {
    return folderValue !== undefined ? folderValue : workspaceValue;
}

/**
 * The resource-scoped inspect() snapshot the v2 provider consumes. Same
 * layer shapes and workspaceValue/globalValue semantics as the
 * pre-migration push bridge (doc 11 §10, commit 7), with the folder tier
 * composed in front of the workspace tier (UX-05): for the project's own
 * resource, a folder-scoped setting (`workspaceFolderValue`) wins, its
 * absence falls back to the workspace value, and the user tier stays
 * `globalValue`. Templates compose per category and per field, so a folder
 * override of one template entry never replaces unrelated categories or
 * fields.
 */
function readLayerSnapshot(resource?: vscode.Uri): PzStudioHostSettings {
    const config = vscode.workspace.getConfiguration('pzstudio', resource);
    const outdirInspect = config.inspect<string>('outdir');
    const useSymlinksInspect = config.inspect<boolean>('useSymlinks');

    /**
     * Per-category, per-field template extract. The workspace layer folds
     * the folder tier in front of its tier (folderFirst); the user layer
     * never consults a folder value (no folder tier exists below user).
     */
    const extractTemplates = (
        tierKey: 'workspaceValue' | 'globalValue',
        folderFirst: boolean,
    ) => {
        const result: any = {};
        for (const cat of ['project', 'mod', 'workshop', 'language']) {
            const catConfig = vscode.workspace.getConfiguration(
                `pzstudio.templates.${cat}`,
                resource,
            );
            const urlInspect = catConfig.inspect<string>('url');
            const refInspect = catConfig.inspect<string>('ref');
            const url = folderFirst
                ? composeWorkspace(
                      urlInspect?.workspaceFolderValue,
                      urlInspect?.[tierKey],
                  )
                : urlInspect?.[tierKey];
            const ref = folderFirst
                ? composeWorkspace(
                      refInspect?.workspaceFolderValue,
                      refInspect?.[tierKey],
                  )
                : refInspect?.[tierKey];
            if (url) {
                result[cat] = { url, ...(ref ? { ref } : {}) };
            }
        }
        return Object.keys(result).length > 0 ? result : undefined;
    };

    return {
        workspace: {
            // Folder-scoped values apply for this project's resource; the
            // workspace value covers everything the folder leaves unset.
            templates: extractTemplates('workspaceValue', true),
            outdir: composeWorkspace(
                outdirInspect?.workspaceFolderValue,
                outdirInspect?.workspaceValue,
            ),
            useSymlinks: composeWorkspace(
                useSymlinksInspect?.workspaceFolderValue,
                useSymlinksInspect?.workspaceValue,
            ),
        },
        user: {
            templates: extractTemplates('globalValue', false),
            outdir: outdirInspect?.globalValue,
            useSymlinks: useSymlinksInspect?.globalValue,
        },
    };
}

/**
 * Pure host settings reader for the v2 instance (doc 11 §10, commit 7).
 * Returns the layered snapshot, read fresh at each call; the legacy push
 * machinery (updateVsCodeSettings / subscribeToConfigurationChanges →
 * setVsCodeSettings) is gone — an external consumer of the CLI's legacy
 * facade feeds the slots directly.
 *
 * UX-05: the provider's `context.projectDir` is the effective project of
 * THIS operation (the v2 lifecycle resolves it post-parse), so the
 * snapshot is read resource-aware for that project: folder-scoped values
 * apply only for the folder owning it, a project outside every opened
 * folder (and a project-less global run, whose context falls back to
 * cwd) sees exactly the workspace/user fallback, and no unrelated
 * folder's settings can leak.
 */
export function readPzStudioHostSettings(
    context: PzStudioSettingsContext,
): PzStudioHostSettings {
    return readLayerSnapshot(
        context.projectDir ? vscode.Uri.file(context.projectDir) : undefined,
    );
}
