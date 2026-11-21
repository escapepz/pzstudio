import * as vscode from 'vscode';
import type { ConsoleLogFinding, ConsoleLogReport } from '@pzstudio/cli/api';

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

function publishDiagnostics(
    collection: vscode.DiagnosticCollection,
    report: ConsoleLogReport,
): void {
    const bySourceFile = new Map<string, vscode.Diagnostic[]>();
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
        const bucket = bySourceFile.get(finding.sourceFile);
        if (bucket) {
            bucket.push(diagnostic);
        } else {
            bySourceFile.set(finding.sourceFile, [diagnostic]);
        }
    }
    for (const [sourceFile, diagnostics] of bySourceFile) {
        collection.set(sourceFileUri(sourceFile), diagnostics);
    }
}

function sourceFileUri(sourceFile: string): vscode.Uri {
    return sourceFile.startsWith('file:')
        ? vscode.Uri.parse(sourceFile)
        : vscode.Uri.file(sourceFile);
}
