import * as vscode from 'vscode';
import { runProjectDoctor, DoctorReport } from 'pzstudio-cli/api';

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

/**
 * Runs the same diagnostics engine `pzstudio doctor` uses for one project
 * — never duplicated validation, just the host wiring the engine expects.
 * Throws only when the engine itself is unusable; findings are data.
 */
export async function runProjectDiagnostics(
    projectDir: vscode.Uri,
): Promise<ProjectDiagnosticsSummary> {
    const report = await runProjectDoctor(projectDir.fsPath);
    const count = (severity: string) =>
        report.diagnostics.filter((d) => d.severity === severity).length;
    return {
        errors: count('error'),
        warnings: count('warning'),
        infos: count('info'),
        report,
    };
}
