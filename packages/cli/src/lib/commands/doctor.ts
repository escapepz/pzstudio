import * as pc from 'picocolors';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { log } from '../logger';
import { CliError } from '../errors';
import { printJsonEnvelope } from '../json';
import { projectDir } from '../helper';
import { extractFlag, hasFlag } from '../args';
import { runProjectDoctor } from '../doctor';

addHelp(
    'doctor',
    `Check the project and its environment for problems.

    Usages:
        pzstudio doctor                          - Run every check and print the report
        pzstudio doctor --game-build 42.20.1     - Also check pzBuildCompatibility against a game build
        pzstudio doctor --json                   - Print a machine-readable envelope instead

    The report exits with code 1 when it finds errors. Warnings are
    advisory and never block a build.`,
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

export async function doctorCmd() {
    const gameBuild = extractFlag('game-build');
    const report = await runProjectDoctor(projectDir(), { gameBuild });

    const counts = { errors: 0, warnings: 0, infos: 0 };
    for (const diagnostic of report.diagnostics) {
        if (diagnostic.severity === 'error') counts.errors++;
        else if (diagnostic.severity === 'warning') counts.warnings++;
        else counts.infos++;
    }

    // Machine output (CLI-8): the envelope is the ONLY stdout content of
    // the command — no human header, no report lines. Exit code follows
    // the result: blocking issues print the envelope (result.status
    // 'error') and still exit 1.
    if (hasFlag('json')) {
        printJsonEnvelope('doctor', {
            status:
                counts.errors > 0
                    ? 'error'
                    : counts.warnings > 0
                      ? 'warnings'
                      : 'ok',
            projectDir: report.projectDir,
            ...(gameBuild ? { gameBuild } : {}),
            counts,
            diagnostics: report.diagnostics.map((diagnostic) => ({
                severity: diagnostic.severity,
                module: diagnostic.module,
                code: diagnostic.code,
                message: diagnostic.message,
                ...(diagnostic.hint ? { hint: diagnostic.hint } : {}),
            })),
        });
        if (counts.errors > 0) {
            throw new CliError(
                `Doctor found ${counts.errors} blocking issues. See the report above.`,
            );
        }
        return;
    }

    const title = report.project?.config.workshop.title;
    log(`PZ Studio doctor — ${title ? `'${title}'` : report.projectDir}`);

    if (report.diagnostics.length === 0) {
        log('✓ Ready to develop.');
        return;
    }

    for (const diagnostic of report.diagnostics) {
        const glyph = severityColor(
            SEVERITY_GLYPHS[diagnostic.severity] ?? '·',
            diagnostic.severity,
        );
        log(`  ${glyph} [${diagnostic.module}] ${diagnostic.message}`);
        if (diagnostic.hint) {
            log(`      ${pc.gray('→')} ${pc.gray(diagnostic.hint)}`);
        }
    }

    log(
        `\nSummary: ${counts.errors} error(s), ${counts.warnings} warning(s), ${counts.infos} info(s).`,
    );

    // Verdict follows the result (CLI-7): the report closes with what it
    // means for the user, and the exit code stays 1 only for errors.
    if (counts.errors > 0) {
        log(`✗ Doctor found ${counts.errors} blocking issues.`);
        throw new CliError(
            `Doctor found ${counts.errors} blocking issues. See the report above.`,
        );
    }
    if (counts.warnings === 0) {
        log('✓ Ready to develop.');
    } else {
        log(
            `⚠ Doctor completed with ${counts.warnings} warnings. You can continue, but review the items above.`,
        );
    }
}

registerCommand({
    name: 'doctor',
    summary: 'Check the project and environment for problems.',
    flags: [{ name: 'game-build', takesValue: true }, { name: 'json' }],
    run: () => doctorCmd(),
});
