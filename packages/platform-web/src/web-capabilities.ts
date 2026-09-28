import type { PlatformCapabilities } from '@pzstudio/platform';

/**
 * Capability profile of the web extension host (vscode.dev / github.dev):
 * no shell, no local executables, no symlinks and no direct access to the
 * local game installation — but the workspace is writable and a portable
 * build archive (zip) can be produced in memory.
 */
export const WEB_CAPABILITIES: PlatformCapabilities = {
    node: false,
    shell: false,
    localExecutables: false,
    symlinks: false,
    workspaceWrite: true,
    workshopOutput: false,
    portableBuild: true,
};
