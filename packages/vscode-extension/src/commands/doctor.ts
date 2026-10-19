import * as vscode from 'vscode';
import { t } from '../util/l10n';
import { asProjectNode } from '../providers/projectExplorer';
import { resolveProjectDir, warnNoProject } from '../util/project';
import type {
    ProjectDiagnosticsRunner,
    ProjectDiagnosticsSummary,
} from '../util/doctor';

const SEVERITY_ICONS: Record<string, string> = {
    error: '$(error)',
    warning: '$(warning)',
    info: '$(info)',
};

/**
 * Project diagnostics report: resolves the project like every other
 * command (or takes the tree-row context), runs the shared diagnostics
 * engine and lists the findings in a quick-pick. Findings themselves come
 * from @pzstudio/core — this command only renders them.
 *
 * UX-16/UX-11: an unexpected failure from a user-invoked run is routed
 * through the handed host-owned logger error sink (one notification,
 * full detail in the PZ Studio Output, localized Show Details, no
 * auto-open, cancellation stays silent) instead of rejecting raw from
 * the command handler. Automatic explorer diagnostics failures never
 * reach this handler.
 */
export function registerDoctorCommand(
    runProjectDiagnostics: ProjectDiagnosticsRunner,
    onError?: (error: unknown) => void,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        'pzstudio.doctor',
        async (node?: unknown) => {
            const action = 'run diagnostics for';
            const dir =
                asProjectNode(node)?.projectDir ??
                (await resolveProjectDir(action));
            if (!dir) {
                warnNoProject(action);
                return;
            }

            let summary: ProjectDiagnosticsSummary;
            try {
                summary = await runProjectDiagnostics(dir);
            } catch (error) {
                onError?.(error);
                return;
            }
            const name = dir.path.split('/').pop() ?? dir.fsPath;

            if (summary.report.diagnostics.length === 0) {
                vscode.window.showInformationMessage(
                    t(
                        "PZStudio: no problems found in '{0}'. Everything looks good.",
                        name,
                    ),
                );
                return;
            }

            await vscode.window.showQuickPick(
                summary.report.diagnostics.map((d) => ({
                    label: `${SEVERITY_ICONS[d.severity] ?? '$(info)'} ${d.message}`,
                    description: `[${d.module}] ${d.code}`,
                    detail: d.hint,
                })),
                {
                    title: t("Diagnostics for '{0}'", name),
                    placeHolder: t(
                        '{0} error(s), {1} warning(s), {2} info(s) — nothing was changed',
                        summary.errors,
                        summary.warnings,
                        summary.infos,
                    ),
                },
            );
        },
    );
}
