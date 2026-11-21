import * as vscode from 'vscode';
import type { DoctorReport, PzStudio } from '@pzstudio/cli/api';

export interface ProjectDiagnosticsSummary {
    errors: number;
    warnings: number;
    infos: number;
    report: DoctorReport;
}

export type ProjectDiagnosticsRunner = (
    projectDir: vscode.Uri,
) => Promise<ProjectDiagnosticsSummary>;

function resolveGameBuild(projectDir: vscode.Uri): string {
    return (
        vscode.workspace
            .getConfiguration('pzstudio', projectDir)
            .get<string>('gameBuild', '') ?? ''
    );
}

export function createProjectDiagnostics(
    studio: PzStudio,
): ProjectDiagnosticsRunner {
    return async (projectDir) => {
        const gameBuild = resolveGameBuild(projectDir);
        const report = await studio.runProjectDoctor(
            projectDir.fsPath,
            ...(gameBuild ? [{ gameBuild }] : []),
        );
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
