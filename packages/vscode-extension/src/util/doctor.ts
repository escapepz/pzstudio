import * as vscode from 'vscode';
import type { DoctorReport, PzStudio } from '@pzstudio/cli/api';

/**
 * The shared diagnostics run reduced for UI consumption: counts for the
 * explorer badge plus the full report for the doctor quick-pick.
 */
export interface ProjectDiagnosticsSummary {
    errors: number;
    warnings: number;
    infos: number;
    report: DoctorReport;
}

/** The bound diagnostics run the doctor command and the explorer share. */
export type ProjectDiagnosticsRunner = (
    projectDir: vscode.Uri,
) => Promise<ProjectDiagnosticsSummary>;

/**
 * Binds the shared diagnostics run to the host PzStudio instance (doc 11
 * §17 commit 10): studio.runProjectDoctor resolves with an explicit
 * project context — no legacy anchor save/restore, instance logger, no
 * legacy slots (§13 v2 column). The doctor quick-pick and the explorer
 * badge consume the same bound runner.
 */
export function createProjectDiagnostics(
    studio: PzStudio,
): ProjectDiagnosticsRunner {
    return async (projectDir) => {
        const report = await studio.runProjectDoctor(projectDir.fsPath);
        const count = (severity: string) =>
            report.diagnostics.filter((d) => d.severity === severity).length;
        return {
            errors: count('error'),
            warnings: count('warning'),
            infos: count('info'),
            report,
        };
    };
}
