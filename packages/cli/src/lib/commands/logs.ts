import * as pc from 'picocolors';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { log } from '../logger';
import { CliError } from '../errors';
import { printJsonEnvelope } from '../json';
import { projectDir } from '../helper';
import { extractFlag, hasFlag } from '../args';
import { analyzeGameLogFile, buildProjectContext } from '../consoleLogHost';
import type { ConsoleLogFinding, ConsoleLogReport } from '@pzstudio/core';

addHelp(
    'logs',
    `Analyze the last Project Zomboid console.txt session.

    Usages:
        pzstudio logs                            - Analyze <home>/Zomboid/console.txt
        pzstudio logs --log <path>               - Analyze a specific console.txt file
        pzstudio logs --debug-logs               - The log was captured with -debug (DEBUG lines stay finding-free)
        pzstudio logs --json                     - Print a machine-readable envelope instead

    Findings are attributed to the mods of the open project when one is
    discoverable; without a project the report stays unattributed. The
    command exits with code 1 when the log has error-severity findings or
    could not be read.`,
);

const SEVERITY_GLYPHS: Record<string, string> = {
    error: '✗',
    warning: '⚠',
    info: '·',
};

function severityColor(text: string, severity: string): string {
    if (severity === 'error') return pc.red(text);
    if (severity === 'warning') return pc.yellow(text);
    return pc.gray(text);
}

/**
 * The gray click-to-file hint under a finding: the owning mod and the
 * workspace source location when attribution resolved them. Unattributed
 * findings print no hint line (never guess).
 */
function findingHint(finding: ConsoleLogFinding): string | undefined {
    if (finding.modId === undefined && finding.sourceFile === undefined) {
        return undefined;
    }
    const parts: string[] = [];
    if (finding.modId !== undefined) {
        parts.push(`[mod: ${finding.modId}]`);
    }
    if (finding.sourceFile !== undefined) {
        const line = finding.line !== undefined ? `:${finding.line}` : '';
        parts.push(`${finding.sourceFile}${line}`);
    }
    return parts.join(' ');
}

export async function logsCmd() {
    // Optional, non-fatal project discovery: the analyzer works without an
    // open project (findings stay unattributed), so a missing or invalid
    // project.json only costs attribution, never the report.
    let context;
    try {
        context = buildProjectContext(projectDir());
    } catch {
        context = undefined;
    }

    const report = await analyzeGameLogFile(extractFlag('log'), context, {
        includeDebug: hasFlag('debug-logs'),
    });

    const counts = { errors: 0, warnings: 0, infos: 0 };
    for (const finding of report.findings) {
        if (finding.severity === 'error') counts.errors++;
        else if (finding.severity === 'warning') counts.warnings++;
        else counts.infos++;
    }

    // Status follows the result (CLI-7): an unreadable log or any
    // error-severity finding blocks (exit 1); warnings are advisory.
    const status =
        report.log.readError !== undefined || counts.errors > 0
            ? 'error'
            : counts.warnings > 0
              ? 'warnings'
              : 'ok';

    // Machine output (CLI-8): the envelope is the ONLY stdout content of
    // the command — no human header, no report lines. Exit code follows
    // the result.
    if (hasFlag('json')) {
        printJsonEnvelope('logs', {
            status,
            log: report.log,
            stats: report.stats,
            session: report.session,
            findings: report.findings,
        });
        if (status === 'error') {
            throw logsError(report, counts.errors);
        }
        return;
    }

    log(`PZ Studio logs — ${report.log.path}`);

    if (report.log.readError !== undefined) {
        log(`✗ cannot read ${report.log.path}: ${report.log.readError}`);
        throw logsError(report, counts.errors);
    }

    for (const finding of report.findings) {
        const glyph = severityColor(
            SEVERITY_GLYPHS[finding.severity] ?? '·',
            finding.severity,
        );
        log(`  ${glyph} [${finding.category}] ${finding.message}`);
        const hint = findingHint(finding);
        if (hint) {
            log(`      ${pc.gray('→')} ${pc.gray(hint)}`);
        }
    }

    log(
        `\nSummary: ${counts.errors} error(s), ${counts.warnings} warning(s), ${counts.infos} info(s).`,
    );

    // DEBUG volume is count-and-dropped by the engine (never findings);
    // the count proves a -debug capture to the user.
    const debugTotal = Object.values(report.stats.debugByChannel).reduce(
        (sum, n) => sum + n,
        0,
    );
    if (debugTotal > 0) {
        const channels = Object.entries(report.stats.debugByChannel)
            .map(([channel, n]) => `${channel}: ${n}`)
            .join(', ');
        log(`Debug lines: ${debugTotal} (${channels}).`);
    }

    if (!report.log.gameExited) {
        log(
            `⚠ The log shows no 'GameThread exited.' — the game may still be running; results may be partial.`,
        );
    }

    // Verdict follows the result (CLI-7).
    if (counts.errors > 0) {
        log(`✗ Log analysis found ${counts.errors} error(s).`);
        throw logsError(report, counts.errors);
    }
    if (counts.warnings === 0) {
        log('✓ No findings.');
    } else {
        log(
            `⚠ Log analysis completed with ${counts.warnings} warnings. You can continue, but review the items above.`,
        );
    }
}

/** The structured CliError behind every exit-1 outcome of the command. */
function logsError(report: ConsoleLogReport, errors: number): CliError {
    if (report.log.readError !== undefined) {
        return new CliError(
            `Cannot read the console log '${report.log.path}'. See the report above.`,
        );
    }
    return new CliError(`Logs found ${errors} error(s). See the report above.`);
}

registerCommand({
    name: 'logs',
    summary: 'Analyze the last Project Zomboid console.txt session.',
    flags: [
        { name: 'log', takesValue: true },
        { name: 'debug-logs' },
        { name: 'json' },
    ],
    run: () => logsCmd(),
});
