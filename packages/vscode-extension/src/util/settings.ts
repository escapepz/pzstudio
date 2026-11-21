import * as vscode from 'vscode';
import type {
    PzStudioHostSettings,
    PzStudioSettingsContext,
} from '@pzstudio/cli/api';

function composeWorkspace<T>(
    folderValue: T | undefined,
    workspaceValue: T | undefined,
): T | undefined {
    return folderValue !== undefined ? folderValue : workspaceValue;
}

function readLayerSnapshot(resource?: vscode.Uri): PzStudioHostSettings {
    const config = vscode.workspace.getConfiguration('pzstudio', resource);
    const outdirInspect = config.inspect<string>('outdir');
    const useSymlinksInspect = config.inspect<boolean>('useSymlinks');

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

export function readPzStudioHostSettings(
    context: PzStudioSettingsContext,
): PzStudioHostSettings {
    return readLayerSnapshot(
        context.projectDir ? vscode.Uri.file(context.projectDir) : undefined,
    );
}
