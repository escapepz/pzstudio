import * as vscode from 'vscode';
import { asProjectNode } from '../providers/projectExplorer';

/**
 * UX-13: the missing-mod remediation action. A mod row whose folder is gone
 * from disk (`mod-missing`) must not offer normal-mod operations — its only
 * non-generic repair path is inspecting the project.json entry that declares
 * it. This opens the owning project's project.json for reading (`vscode.open`,
 * the same open command tree file rows use): the document is never rewritten
 * by this handler, and no entry is removed implicitly — manual editing plus
 * the explorer refresh is the approved lean v1 flow.
 */
export function registerOpenProjectJsonCommand(): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.openProjectJson',
        async (node?: unknown) => {
            // Context-menu only: without an attached project row there is no
            // unambiguous project to open, so do nothing instead of guessing.
            const projectDir = asProjectNode(node)?.projectDir;
            if (!projectDir) {
                return;
            }
            await vscode.commands.executeCommand(
                'vscode.open',
                vscode.Uri.joinPath(projectDir, 'project.json'),
            );
        },
    );
}
