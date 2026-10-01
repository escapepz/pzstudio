import * as vscode from 'vscode';
import { setVsCodeSettings } from '@pzstudio/cli/api';

export function updateVsCodeSettings(): void {
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

    setVsCodeSettings(
        {
            templates: extractTemplates('workspaceValue'),
            outdir: outdirInspect?.workspaceValue,
            useSymlinks: useSymlinksInspect?.workspaceValue,
        },
        {
            templates: extractTemplates('globalValue'),
            outdir: outdirInspect?.globalValue,
            useSymlinks: useSymlinksInspect?.globalValue,
        },
    );
}

export function subscribeToConfigurationChanges(): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('pzstudio')) {
            updateVsCodeSettings();
        }
    });
}
