import * as pc from 'picocolors';
import { addHelp } from '../help';
import { registerCommand } from '../registry';
import { log } from '../logger';
import { projectDir } from '../helper';
import { extractFlag } from '../args';
import { runProjectDoctor } from '../doctor';

addHelp(
    'doctor',
    `Check the project and its environment for problems.

    Usages:
        pzstudio doctor                          - Run every check and print the report
        pzstudio doctor --game-build 42.20.1     - Also check pzBuildCompatibility against a game build

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

    const title = report.project?.config.workshop.title;
    log(`PZ Studio doctor — ${title ? `'${title}'` : report.projectDir}`);

    if (report.diagnostics.length === 0) {
        log('No problems found. Everything looks good.');
        return;
    }

    let errors = 0;
    let warnings = 0;
    let infos = 0;
    for (const diagnostic of report.diagnostics) {
        if (diagnostic.severity === 'error') errors++;
        else if (diagnostic.severity === 'warning') warnings++;
        else infos++;

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
        `\nSummary: ${errors} error(s), ${warnings} warning(s), ${infos} info(s).`,
    );

    if (errors > 0) {
        throw new Error(
            `Doctor found ${errors} error(s) in the project. See the report above.`,
        );
    }
    if (warnings === 0) {
        log('No errors or warnings. Everything looks good.');
    }
}

registerCommand({
    name: 'doctor',
    summary: 'Check the project and environment for problems.',
    run: () => doctorCmd(),
});
