import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId, readModConfig, resolveProjectDir } from '../util/project';

/** Editable mod fields, in menu order (mirrors the modconfig whitelist). */
const FIELD_KEYS = [
    'name',
    'description',
    'author',
    'modversion',
    'category',
    'url',
    'icon',
    'poster',
    'versionMin',
    'versionMax',
    'require',
    'incompatible',
    'loadModAfter',
    'loadModBefore',
    'pack',
    'tiledef',
] as const;

const MODINFO_VALUES = ['auto', 'skip', 'auto-if-missing'] as const;

const STATE_CHOICES: Array<{
    label: string;
    action: 'include' | 'devonly' | 'exclude';
}> = [
    { label: 'Include in all builds', action: 'include' },
    { label: 'Build in dev_branch only', action: 'devonly' },
    { label: 'Exclude from build', action: 'exclude' },
];

function fieldValueToString(
    value: string | string[] | undefined,
): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    return Array.isArray(value) ? value.join(', ') : value;
}

export function registerConfigureCommand(
    execute: ExecutePZCommand,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.modConfigure',
        async (node?: unknown) => {
            const modNode = asModNode(node);
            const modId =
                modNode?.modId ?? (await pickModId('Select mod to configure'));
            if (!modId) {
                return;
            }

            const projectDir =
                modNode?.projectDir ??
                (await resolveProjectDir('mod configuration'));
            if (!projectDir) {
                return;
            }

            const snapshot = await readModConfig(projectDir, modId);
            if (!snapshot) {
                vscode.window.showWarningMessage(
                    `Cannot read the configuration of mod '${modId}' — check project.json.`,
                );
                return;
            }

            interface ConfigureItem extends vscode.QuickPickItem {
                pick: 'inclusion' | 'modInfo' | 'field';
                key?: string;
            }

            const items: ConfigureItem[] = [
                {
                    label: '$(gear) Build inclusion…',
                    description: snapshot.state,
                    pick: 'inclusion',
                },
                {
                    label: '$(note) build.modInfo…',
                    description:
                        snapshot.modInfo ?? 'auto-if-missing (default)',
                    pick: 'modInfo',
                },
                ...FIELD_KEYS.map(
                    (key): ConfigureItem => ({
                        label: key,
                        description: fieldValueToString(snapshot.fields[key]),
                        pick: 'field',
                        key,
                    }),
                ),
            ];

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: `Configure mod '${modId}' — pick a field to edit`,
            });
            if (!picked) {
                return;
            }

            if (picked.pick === 'inclusion') {
                const choice = await vscode.window.showQuickPick(
                    STATE_CHOICES,
                    {
                        placeHolder: `Build inclusion of '${modId}' (currently: ${snapshot.state})`,
                    },
                );
                if (choice) {
                    await execute('modconfig', [modId, choice.action]);
                }
                return;
            }

            if (picked.pick === 'modInfo') {
                const choice = await vscode.window.showQuickPick(
                    [...MODINFO_VALUES],
                    {
                        placeHolder: `build.modInfo of '${modId}' (currently: ${snapshot.modInfo ?? 'auto-if-missing (default)'})`,
                    },
                );
                if (choice) {
                    await execute('modconfig', [
                        modId,
                        'set',
                        'modInfo',
                        choice,
                    ]);
                }
                return;
            }

            const key = picked.key!;
            const current = fieldValueToString(snapshot.fields[key]) ?? '';
            const value = await vscode.window.showInputBox({
                prompt: `New value for '${key}' of mod '${modId}' (array fields are comma-separated; clear the input to remove the field)`,
                value: current,
            });
            if (value === undefined) {
                return;
            }
            const trimmed = value.trim();
            if (trimmed === '') {
                if (current === '') {
                    return;
                }
                await execute('modconfig', [modId, 'unset', key]);
                return;
            }
            await execute('modconfig', [modId, 'set', key, trimmed]);
        },
    );
}
