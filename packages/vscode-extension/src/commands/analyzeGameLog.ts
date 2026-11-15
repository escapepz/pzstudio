import * as vscode from 'vscode';
import type { ConsoleLogFinding, ConsoleLogReport } from '@pzstudio/cli/api';

/**
 * The DiagnosticSeverity enum is read lazily, never at module scope: a
 * module-scope map would crash any host whose vscode surface predates the
 * diagnostics API (the bundle activation smoke test registers every command
 * against a minimal stub) before registerCommand could even run.
 */
function diagnosticSeverity(
    severity: ConsoleLogFinding['severity'],
): vscode.DiagnosticSeverity {
    switch (severity) {
        case 'error':
            return vscode.DiagnosticSeverity.Error;
        case 'warning':
            return vscode.DiagnosticSeverity.Warning;
        default:
            return vscode.DiagnosticSeverity.Information;
    }
}

/**
 * "PZ Studio: Analyze Game Log": runs the CLI's console.txt analyzer on the
 * game's default log (the injected analyzer is
 * `(logPath?) => analyzeGameLogFile(logPath)`), reports the session in a
 * dedicated output channel and pins attributed findings as diagnostics on
 * their source files. Findings without a sourceFile stay channel-only —
 * never misattributed as a squiggle. This command only renders: the engine
 * and attribution live in @pzstudio/core behind the CLI API.
 *
 * Both surfaces are singletons per registration — a per-run collection
 * would orphan the previous run's diagnostics — materialized on the first
 * run, so activation only needs registerCommand (the bundle smoke test
 * runs activate() against a vscode stub without the diagnostics APIs). An
 * unexpected failure is routed through the handed host-owned error sink
 * (same UX-16 shape as doctor) instead of rejecting raw from the handler.
 */
export function registerAnalyzeGameLogCommand(
    analyze: (logPath?: string) => Promise<ConsoleLogReport>,
    onError?: (error: unknown) => void,
): vscode.Disposable {
    let channel: vscode.OutputChannel | undefined;
    let collection: vscode.DiagnosticCollection | undefined;

    return vscode.commands.registerCommand(
        'pzstudio.analyzeGameLog',
        async () => {
            try {
                if (!channel) {
                    channel =
                        vscode.window.createOutputChannel('PZ Studio Game Log');
                }
                if (!collection) {
                    collection =
                        vscode.languages.createDiagnosticCollection(
                            'pzstudio-game-log',
                        );
                }
                collection.clear();
                const report = await analyze(undefined);
                renderReport(channel, report);
                publishDiagnostics(collection, report);
                channel.show();
            } catch (error) {
                onError?.(error);
            }
        },
    );
}

/** Channel report: severity summary, then one block per finding. */
function renderReport(
    channel: vscode.OutputChannel,
    report: ConsoleLogReport,
): void {
    const counts = { error: 0, warning: 0, info: 0 };
    for (const finding of report.findings) {
        counts[finding.severity] += 1;
    }
    channel.appendLine(`Game log: ${report.log.path}`);
    channel.appendLine(`Lines: ${report.log.totalLines}`);
    channel.appendLine(
        `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info(s)`,
    );
    if (!report.log.gameExited) {
        channel.appendLine('⚠ log may be partial (no clean game exit)');
    }
    if (report.log.readError) {
        channel.appendLine(`Read error: ${report.log.readError}`);
    }
    for (const finding of report.findings) {
        channel.appendLine(`[${finding.category}] ${finding.message}`);
        if (finding.sourceFile) {
            const location =
                finding.line !== undefined
                    ? `${finding.sourceFile}:${finding.line}`
                    : finding.sourceFile;
            channel.appendLine(
                finding.modId
                    ? `→ ${finding.modId} ${location}`
                    : `→ ${location}`,
            );
        }
    }
}

/**
 * Pins attributed findings as diagnostics; unattributed ones stay out.
 * sourceFile arrives in two shapes: `file://` URIs (the extension wiring
 * remaps each context mod root through vscode.Uri.file) and plain
 * filesystem paths (a context built without the remap — the CLI host emits
 * paths). Only the URI shape is parseable; paths must materialize through
 * Uri.file or a real host rejects the string as a malformed URI.
 */
function publishDiagnostics(
    collection: vscode.DiagnosticCollection,
    report: ConsoleLogReport,
): void {
    for (const finding of report.findings) {
        if (!finding.sourceFile) {
            continue;
        }
        const line = finding.line !== undefined ? finding.line - 1 : 0;
        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(line, 0, line, 500),
            `${finding.category}: ${finding.message}`,
            diagnosticSeverity(finding.severity),
        );
        diagnostic.source = 'pzstudio';
        collection.set(sourceFileUri(finding.sourceFile), [diagnostic]);
    }
}

/** `file:` strings parse as URIs; anything else is a filesystem path. */
function sourceFileUri(sourceFile: string): vscode.Uri {
    return sourceFile.startsWith('file:')
        ? vscode.Uri.parse(sourceFile)
        : vscode.Uri.file(sourceFile);
}
