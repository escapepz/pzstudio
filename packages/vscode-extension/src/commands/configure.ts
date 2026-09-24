import * as vscode from 'vscode';
import { ExecutePZCommand } from '../util/execute';
import { asModNode } from '../providers/projectExplorer';
import { pickModId, readModConfig, resolveProjectDir } from '../util/project';
import { t } from '../util/l10n';

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

/** Build-inclusion choices; a function so labels re-translate on language change. */
function getStateChoices(): Array<{
    label: string;
    action: 'include' | 'devonly' | 'exclude';
}> {
    return [
        { label: t('Include in all builds'), action: 'include' },
        { label: t('Build in dev_branch only'), action: 'devonly' },
        { label: t('Exclude from build'), action: 'exclude' },
    ];
}

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
                modNode?.modId ??
                (await pickModId(t('Select mod to configure')));
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
                    t(
                        "Cannot read the configuration of mod '{0}' — check project.json.",
                        modId,
                    ),
                );
                return;
            }

            interface ConfigureItem extends vscode.QuickPickItem {
                pick: 'inclusion' | 'modInfo' | 'field';
                key?: string;
            }

            const items: ConfigureItem[] = [
                {
                    label: t('$(gear) Build inclusion…'),
                    description: snapshot.state,
                    pick: 'inclusion',
                },
                {
                    label: t('$(note) build.modInfo…'),
                    description:
                        snapshot.modInfo ?? t('auto-if-missing (default)'),
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
                placeHolder: t(
                    "Configure mod '{0}' — pick a field to edit",
                    modId,
                ),
            });
            if (!picked) {
                return;
            }

            if (picked.pick === 'inclusion') {
                const choice = await vscode.window.showQuickPick(
                    getStateChoices(),
                    {
                        placeHolder: t(
                            "Build inclusion of '{0}' (currently: {1})",
                            modId,
                            snapshot.state,
                        ),
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
                        placeHolder: t(
                            "build.modInfo of '{0}' (currently: {1})",
                            modId,
                            snapshot.modInfo ?? t('auto-if-missing (default)'),
                        ),
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
                prompt: t(
                    "New value for '{0}' of mod '{1}' (array fields are comma-separated; clear the input to remove the field)",
                    key,
                    modId,
                ),
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
