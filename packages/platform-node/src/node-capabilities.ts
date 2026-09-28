import type { PlatformCapabilities } from '@pzstudio/platform';

/**
 * Capability profile of a plain Node.js host: everything is available —
 * the workshop output folders live on the local filesystem and shell
 * commands (git, the game client) can be spawned.
 */
export const NODE_CAPABILITIES: PlatformCapabilities = {
    node: true,
    shell: true,
    localExecutables: true,
    symlinks: true,
    workspaceWrite: true,
    workshopOutput: true,
    portableBuild: true,
};
