/**
 * Host-side doctor wiring for Node hosts (the CLI and the VS Code
 * extension, which bundles this API): gathers the inputs the host is
 * responsible for — the effective output directory and the project
 * template cache location — then hands over to the host-blind engine in
 * @pzstudio/core. Diagnostics themselves never live here.
 */
import { join } from 'path';
import { NodeFileSystem, NODE_CAPABILITIES } from '@pzstudio/platform-node';
import { runDoctor, DoctorReport } from '@pzstudio/core';
import {
    getExternalProjectDir,
    getOutDir,
    readProjectConfig,
    setProjectDir,
} from './helper';
import { probeTemplateCacheDir } from './templateManager';

export interface ProjectDoctorOptions {
    /**
     * The running game build (e.g. "42.2.0") to check
     * pzBuildCompatibility against. When omitted the check is skipped.
     */
    gameBuild?: string;
}

/**
 * Runs the full doctor for one project directory. Invalid project.json or
 * an unreadable global config never throw here — they are exactly the
 * findings doctor reports.
 */
export async function runProjectDoctor(
    projectPath: string,
    options: ProjectDoctorOptions = {},
): Promise<DoctorReport> {
    // Anchor config resolution like every other command: getOutDir and the
    // template probe read the anchored project directory and settings. The
    // previous anchor is restored afterwards — this is a library call that
    // must not leak global state into its host (the extension process).
    const previousProjectDir = getExternalProjectDir();
    setProjectDir(projectPath);
    try {
        let outDir: string | undefined;
        try {
            const config = readProjectConfig(join(projectPath, 'project.json'));
            if (config) {
                outDir = getOutDir(config);
            }
        } catch {
            // An invalid project.json is itself a doctor finding (reported
            // by the engine); output-directory checks are skipped for this
            // run.
        }

        let template: { dir: string; name: string } | undefined;
        try {
            template = probeTemplateCacheDir('project');
        } catch {
            // No template configured or unreadable global config: nothing
            // to check.
        }

        return await runDoctor(new NodeFileSystem(), {
            projectDir: projectPath,
            outDir,
            templateDir: template?.dir,
            templateName: template?.name,
            capabilities: NODE_CAPABILITIES,
            gameBuild: options.gameBuild,
        });
    } finally {
        setProjectDir(previousProjectDir);
    }
}
