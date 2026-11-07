import * as vscode from 'vscode';
import { TextDecoder } from 'util';

type Bundle = Record<string, string>;

/**
 * Display-language override for the extension UI (pzstudio.language).
 *
 * 'auto' (default) leaves the bundle undefined so t() delegates to
 * vscode.l10n, which follows the VS Code display language. Any other
 * value loads the matching bundle file from the extension's l10n/ folder
 * so the UI can differ from VS Code itself. Strings rendered by VS Code
 * from the manifest (command titles, setting descriptions) always follow
 * the VS Code display language; that part is not overridable.
 */
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
        // Missing/unreadable locale file: fall back to the English bundle,
        // and if even that fails stay on the vscode.l10n delegate.
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

/**
 * Applies pzstudio.language: 'auto' clears the override, anything else
 * loads the locale bundle. Idempotent — call again whenever the setting
 * changes.
 */
export async function initExtensionL10n(
    context: vscode.ExtensionContext,
): Promise<void> {
    const language = vscode.workspace
        .getConfiguration('pzstudio')
        .get<string>('language', 'auto');
    bundle =
        language === 'auto' ? undefined : await loadBundle(context, language);
}

/** Translates through the override bundle when active, else vscode.l10n. */
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
