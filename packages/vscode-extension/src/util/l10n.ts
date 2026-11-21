import * as vscode from 'vscode';
import { TextDecoder } from 'util';

type Bundle = Record<string, string>;

let bundle: Bundle | undefined;

const decoder = new TextDecoder();

async function readBundle(uri: vscode.Uri): Promise<Bundle> {
    const contents = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(decoder.decode(contents)) as unknown;
    return typeof parsed === 'object' && parsed !== null
        ? (parsed as Bundle)
        : {};
}

async function loadBundle(
    context: vscode.ExtensionContext,
    language: string,
): Promise<Bundle | undefined> {
    const fileName =
        language === 'en' ? 'bundle.l10n.json' : `bundle.l10n.${language}.json`;
    try {
        return await readBundle(
            vscode.Uri.joinPath(context.extensionUri, 'l10n', fileName),
        );
    } catch {
        if (fileName === 'bundle.l10n.json') {
            return undefined;
        }
        try {
            return await readBundle(
                vscode.Uri.joinPath(
                    context.extensionUri,
                    'l10n',
                    'bundle.l10n.json',
                ),
            );
        } catch {
            return undefined;
        }
    }
}

export async function initExtensionL10n(
    context: vscode.ExtensionContext,
): Promise<void> {
    const language = vscode.workspace
        .getConfiguration('pzstudio')
        .get<string>('language', 'auto');
    bundle =
        language === 'auto' ? undefined : await loadBundle(context, language);
}

export function t(
    message: string,
    ...args: Array<string | number | boolean>
): string {
    if (bundle === undefined) {
        return vscode.l10n.t(message, ...args);
    }
    let text = bundle[message] ?? message;
    for (let index = 0; index < args.length; index++) {
        text = text.replaceAll(`{${index}}`, String(args[index]));
    }
    return text;
}
