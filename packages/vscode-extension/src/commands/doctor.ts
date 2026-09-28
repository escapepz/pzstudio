import * as vscode from 'vscode';
import { t } from '../util/l10n';
import { asProjectNode } from '../providers/projectExplorer';
import { resolveProjectDir, warnNoProject } from '../util/project';
import {
    runProjectDiagnostics,
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
 */
export function registerDoctorCommand(): vscode.Disposable {
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

            const summary: ProjectDiagnosticsSummary =
                await runProjectDiagnostics(dir);
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
