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
 * The resource-scoped pzstudio.gameBuild for ONE project (UX-11): empty —
 * default or explicitly cleared — disables the pzBuildCompatibility
 * check; a nonempty string is the value the user explicitly provided (no
 * automatic detection, no Build 41 commitment, nothing written to project
 * configuration). Resolved per run against the project's own URI, so two
 * folders with different settings get their own values and a project
 * outside every opened folder sees only the workspace/user fallback.
 */
function resolveGameBuild(projectDir: vscode.Uri): string {
    return (
        vscode.workspace
            .getConfiguration('pzstudio', projectDir)
            .get<string>('gameBuild', '') ?? ''
    );
}

/**
 * Binds the shared diagnostics run to the host PzStudio instance (doc 11
 * §17 commit 10): studio.runProjectDoctor resolves with an explicit
 * project context — no legacy anchor save/restore, instance logger, no
 * legacy slots (§13 v2 column). The doctor quick-pick and the explorer
 * badge consume the same bound runner. UX-11: the effective
 * pzstudio.gameBuild of the project's folder is forwarded — the
 * single-argument call stays the contract while the setting is empty.
 */
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
